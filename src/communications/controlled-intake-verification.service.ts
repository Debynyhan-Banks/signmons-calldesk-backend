import { GoogleCorrectionSequence } from "./google-correction-sequence";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import {
  CustomerConsentCredentials,
  ConsentSessionClaims,
} from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";
import {
  ControlledIntakeAuthority,
  ControlledIntakeScope,
} from "./controlled-intake-authority";
import { DurableVerificationService } from "./durable-verification.service";
import { AddressOperationLedger } from "./address-operation-ledger";
import { AddressOperationExecutor } from "./address-operation-executor";
import { GoogleAddressOAuthTransport } from "./google-address-oauth.transport";
import { reviewGoogleAddressResponse } from "./google-address.adapter";
import { reviewGoogleServiceArea } from "./google-service-area";
import { controlledIntakeConflict } from "./controlled-intake-refusal";

export type ControlledIntakeSubmission = {
  intentId: string;
  revision: number;
  submissionDigest: string;
  policyVersion: string;
  organizationApprovedAt: string;
  phone: string;
  address: { street: string; unit: string; city: string; postalCode: string };
  authorityScope: ControlledIntakeScope;
};
type Ports = {
  corrections?: GoogleCorrectionSequence;
  prisma: Pick<PrismaService, "$transaction">;
  credentials: CustomerConsentCredentials;
  authority: ControlledIntakeAuthority;
  capability: Readonly<object>;
  phone: Pick<DurableVerificationService, "readControlledCurrent">;
  ledger: AddressOperationLedger;
  transport: Pick<GoogleAddressOAuthTransport, "validate">;
  // Resolves customer-confirmed immutable input, never browser proof or Google content.
  readSubmission: (
    tx: Prisma.TransactionClient,
    session: ConsentSessionClaims,
    requestId: string,
  ) => Promise<ControlledIntakeSubmission | null>;
};
const refuse = () =>
  controlledIntakeConflict(
    "CURRENT_VERIFICATION_UNAVAILABLE",
    "Current verification unavailable; no job created.",
  );
const uuid = (s: unknown): s is string =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    s,
  );

/** Unregistered controlled connection. No implicit credentials, live client or
 * job writes. P04 checks committed replay BEFORE invoking this service and owns
 * the final short transaction. Only the callback can consume this request's
 * transient result; it cannot be serialized, replayed or used after return.
 */
export class ControlledIntakeVerificationService {
  constructor(private readonly ports?: Ports) {}

  async run<T>(
    input: { sessionToken: string; requestId: string },
    consume: (
      check: (tx: Prisma.TransactionClient) => Promise<void>,
      beforeCommit: (tx: Prisma.TransactionClient) => Promise<void>,
    ) => Promise<T>,
  ) {
    const p = this.ports;
    if (
      !p ||
      !input ||
      Object.keys(input).sort().join() !== "requestId,sessionToken" ||
      !uuid(input.requestId) ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096
    )
      throw refuse();
    input = { ...input };
    const session = p.credentials.verifySession(input.sessionToken);
    const read = async (tx: Prisma.TransactionClient) => {
      p.credentials.verifySession(input.sessionToken);
      if ((await lockCustomerConsentSession(tx, session)).status !== "ONGOING")
        throw refuse();
      const loaded = await p.readSubmission(tx, session, input.requestId);
      if (
        !loaded ||
        !uuid(loaded.intentId) ||
        !Number.isSafeInteger(loaded.revision) ||
        loaded.revision < 1 ||
        !/^[a-f0-9]{64}$/.test(loaded.submissionDigest) ||
        loaded.authorityScope?.tenantId !== session.tenantId ||
        !/^\+1[2-9]\d{9}$/.test(loaded.phone) ||
        !Number.isFinite(Date.parse(loaded.organizationApprovedAt))
      )
        throw refuse();
      const snapshot = structuredClone(loaded);
      // Reuse the parser's strict input check before reserving any operation.
      if (
        reviewGoogleAddressResponse(snapshot.address, null).status ===
        "INVALID_INPUT"
      )
        throw refuse();
      const actor = await p.authority.check(
        p.capability,
        tx,
        snapshot.authorityScope,
      );
      if (actor.policyVersion !== snapshot.policyVersion) throw refuse();
      const phone = await p.phone.readControlledCurrent(tx, {
        sessionToken: input.sessionToken,
        phone: snapshot.phone,
        businessPolicyVersion: snapshot.organizationApprovedAt,
      });
      if (!phone) throw refuse();
      return { snapshot, phone };
    };
    const initial = await p.prisma.$transaction(read);
    const executor = new AddressOperationExecutor(p.ledger);
    const observed = await executor.runControlled(
      input,
      async (signal, claim) => {
        if (
          claim.fixtureOnly !== false ||
          claim.intentId !== initial.snapshot.intentId ||
          claim.revision !== initial.snapshot.revision ||
          !claim.attemptId ||
          !claim.executionDeadline
        )
          throw refuse();
        const address = initial.snapshot.address;
        const sequenceKey = JSON.stringify([
          session.tenantId,
          session.sessionId,
          session.conversationId,
          initial.snapshot.authorityScope.serviceCategoryId,
          initial.snapshot.policyVersion,
          initial.snapshot.organizationApprovedAt,
        ]);
        const previousResponseId = p.corrections?.take(sequenceKey);
        if (
          !Number.isSafeInteger(claim.priorSessionOperations) ||
          claim.priorSessionOperations < 0 ||
          (claim.priorSessionOperations > 0 && !previousResponseId)
        )
          return { status: "REFUSED" as const };
        const response = await p.transport.validate(
          {
            address: {
              addressLines: [
                address.street,
                ...(address.unit ? [address.unit] : []),
              ],
              locality: address.city,
              postalCode: address.postalCode,
              administrativeArea: "OH",
              regionCode: "US",
            },
            enableUspsCass: true,
            ...(claim.priorSessionOperations > 0 ? { previousResponseId } : {}),
          },
          signal,
        );
        if (signal.aborted || response.status !== "RESPONSE") throw refuse();
        const preview = reviewGoogleAddressResponse(address, response.body);
        if (preview.status === "CORRECTION_REQUIRED") {
          if (
            !previousResponseId &&
            !p.corrections?.remember(
              sequenceKey,
              response.body.responseId,
              session.expiresAt,
            )
          )
            return { status: "REFUSED" as const };
          return {
            status: "CORRECTION_REQUIRED" as const,
            candidate: preview.candidate,
          };
        }
        if (preview.status !== "REVIEW") return { status: "REFUSED" as const };
        const checkedAt = Date.now();
        const binding = {
          tenantId: session.tenantId,
          sessionId: session.sessionId,
          addressRevision: initial.snapshot.revision,
          policyVersion: initial.snapshot.policyVersion,
        };
        const area = await reviewGoogleServiceArea(
          address,
          response.body,
          {
            current: binding,
            confirmed: binding,
            customerConfirmed: true,
            checkedAt,
            now: checkedAt,
            expiresAt: Math.min(
              claim.executionDeadline,
              session.expiresAt,
              initial.phone.expiresAt,
            ),
          },
          "REVIEW_ONLY",
        );
        if (area.coverage !== "IN_AREA") return { status: "REFUSED" as const };
        // Only internal operation identity/time survives this stack frame. No Google body,
        // county, verdict, responseId, provider hash or permanent proof is returned.
        return { status: "READY" as const, claim, checkedAt };
      },
    );
    if (observed.status !== "OBSERVED")
      return { status: "UNCERTAIN" as const, jobCreated: false as const };
    const value = observed.value;
    if (value.status !== "READY")
      return { ...value, jobCreated: false as const };
    let active = true;
    let checked = false;
    let passed = false;
    let checkedTx: Prisma.TransactionClient | undefined;
    let phoneExpiresAt = 0;
    const beforeCommit = async (tx: Prisma.TransactionClient) => {
      if (!active || !passed || tx !== checkedTx) throw refuse();
      await p.authority.check(
        p.capability,
        tx,
        initial.snapshot.authorityScope,
      );
      const [clock] = await tx.$queryRaw<{ ms: bigint }[]>(
        Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
      );
      const now = Number(clock?.ms);
      if (
        !Number.isSafeInteger(now) ||
        now < value.checkedAt ||
        now >= value.claim.executionDeadline! ||
        now >= phoneExpiresAt ||
        now >= session.expiresAt
      )
        throw refuse();
      p.credentials.verifySession(input.sessionToken, now);
    };
    try {
      const result = await consume(async (tx) => {
        if (!active || checked) throw refuse();
        checked = true; // A failed/overlapping attempt cannot renew this observation.
        const current = await read(tx);
        if (
          JSON.stringify(current.snapshot) !== JSON.stringify(initial.snapshot)
        )
          throw refuse();
        await p.ledger.checkControlledObservation(tx, {
          ...input,
          operationId: value.claim.operationId,
          attemptId: value.claim.attemptId!,
          intentId: value.claim.intentId,
          revision: value.claim.revision,
          policyHash: value.claim.policyHash,
          executionDeadline: value.claim.executionDeadline!,
        });
        await p.authority.check(
          p.capability,
          tx,
          current.snapshot.authorityScope,
        );
        const [clock] = await tx.$queryRaw<{ ms: bigint }[]>(
          Prisma.sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS ms`,
        );
        const now = Number(clock?.ms);
        if (
          !active ||
          !Number.isSafeInteger(now) ||
          now < value.checkedAt ||
          now >= value.claim.executionDeadline! ||
          now >= current.phone.expiresAt ||
          now >= session.expiresAt
        )
          throw refuse();
        passed = true;
        checkedTx = tx;
        phoneExpiresAt = current.phone.expiresAt;
      }, beforeCommit);
      if (!passed) throw refuse();
      return { status: "CONSUMED" as const, value: result };
    } finally {
      active = false;
    }
  }
}
