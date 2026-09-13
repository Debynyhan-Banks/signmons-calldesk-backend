import { ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { CustomerIntakeContinuationService } from "./customer-intake-continuation.service";
import { ControlledIntakeAuthority } from "./controlled-intake-authority";
import { controlledIntakeSubmission } from "./controlled-intake-submission";
import {
  ControlledIntakeVerificationService,
  ControlledIntakeSubmission,
} from "./controlled-intake-verification.service";
import { DurableVerificationService } from "./durable-verification.service";
import { GoogleAddressOAuthTransport } from "./google-address-oauth.transport";
import {
  AddressOperationLedger,
  ControlledAddressOperationPolicy,
} from "./address-operation-ledger";

type Resources = {
  prisma: Pick<PrismaService, "$transaction">;
  credentials: CustomerConsentCredentials;
  intake: CustomerIntakeContinuationService;
  tenantId: string;
  integrationId: string;
  origin: string;
  authority: ControlledIntakeAuthority;
  capability: Readonly<object>;
  phone: Pick<DurableVerificationService, "readControlledCurrent">;
  transport: Pick<GoogleAddressOAuthTransport, "validate">;
  addressAccountId: string;
  readAddressPolicy: (
    tx: Prisma.TransactionClient,
    submission: ControlledIntakeSubmission,
  ) => Promise<ControlledAddressOperationPolicy | null>;
};

/** Server-owned composition only. No environment loader, clients, listener or DI
 * registration. An omitted resource bundle is disabled. Never inject from HTTP.
 * Receipt replay happens in intake before constructing verification or its ledger.
 */
export class ControlledIntakeComposition {
  constructor(private readonly resources?: Resources) {}

  async submit(value: unknown) {
    const p = this.resources;
    if (!p)
      throw new ServiceUnavailableException("Controlled intake unavailable.");
    const input = controlledIntakeSubmission(value);
    const session = p.credentials.verifySession(input.sessionToken);
    if (session.tenantId !== p.tenantId)
      throw new ServiceUnavailableException("Controlled intake unavailable.");
    return p.intake.submitControlled(input, {
      integrationId: p.integrationId,
      origin: p.origin,
      authority: p.authority,
      capability: p.capability,
      verification: async (reader) => {
        // Invoked only after committed replay and intake preflight. No provider I/O
        // in this transaction. The reader checks current policy and service authority.
        const initial = await p.prisma.$transaction((tx) =>
          reader(tx, session, input.requestId),
        );
        const ledger = new AddressOperationLedger(
          p.prisma,
          p.credentials,
          undefined,
          {
            accountId: p.addressAccountId,
            authority: p.authority,
            capability: p.capability,
            scope: initial.authorityScope,
            readBinding: async (tx, scope) => {
              if (
                scope.tenantId !== session.tenantId ||
                scope.sessionId !== session.sessionId ||
                scope.conversationId !== session.conversationId
              )
                throw new ServiceUnavailableException(
                  "Controlled intake unavailable.",
                );
              const current = await reader(tx, session, input.requestId);
              if (
                current.submissionDigest !== initial.submissionDigest ||
                current.authorityScope.serviceCategoryId !==
                  initial.authorityScope.serviceCategoryId
              )
                throw new ServiceUnavailableException(
                  "Controlled intake unavailable.",
                );
              const policy = await p.readAddressPolicy(tx, current);
              return policy
                ? {
                    intentId: current.intentId,
                    revision: current.revision,
                    policy,
                  }
                : null;
            },
          },
        );
        return new ControlledIntakeVerificationService({
          prisma: p.prisma,
          credentials: p.credentials,
          authority: p.authority,
          capability: p.capability,
          phone: p.phone,
          ledger,
          transport: p.transport,
          readSubmission: reader,
        });
      },
    });
  }
}
