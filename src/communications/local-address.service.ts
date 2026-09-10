import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMemoryCipher } from "../logging/conversation-memory-cipher.service";
import { CustomerConsentCredentials } from "./customer-consent-credentials";
import { lockCustomerConsentSession } from "./customer-consent-session-lock";

type Candidate = { id: string; address: string; postalCode: string };
type Area = {
  id: string;
  type: string;
  status: string;
  definition: unknown;
  updatedAt: Date;
};
type State = {
  version: 1;
  revision: number;
  query: string;
  unit: string;
  candidates: string[];
  selected: string;
  policy: string;
  lastId: string;
  lastDigest: string;
};
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function localZipCoverage(areas: Area[], postalCode: string) {
  const active = areas.filter((a) => a.status === "ACTIVE");
  if (!/^\d{5}$/.test(postalCode) || !active.length) return "UNKNOWN";
  const lists: string[][] = [];
  for (const area of active) {
    const definition = area.definition as { postalCodes?: unknown } | null;
    if (
      area.type !== "ZIP" ||
      !definition ||
      !Array.isArray(definition.postalCodes) ||
      !definition.postalCodes.length ||
      !definition.postalCodes.every(
        (v: unknown) => typeof v === "string" && /^\d{5}(-\d{4})?$/.test(v),
      )
    )
      return "UNKNOWN";
    lists.push(definition.postalCodes as string[]);
  }
  return lists.some((list) =>
    list.some((zip) => zip.slice(0, 5) === postalCode),
  )
    ? "FIXTURE_IN_AREA"
    : "OUT_OF_AREA";
}

/** Injected fictional catalog only. No geocoder, master-address writes or production registration. */
export class LocalAddressService {
  private readonly catalog: Candidate[];
  private readonly catalogHash: string;
  constructor(
    private readonly prisma: Pick<PrismaService, "$transaction">,
    private readonly cipher: Pick<
      ConversationMemoryCipher,
      "encrypt" | "decrypt"
    >,
    private readonly credentials: CustomerConsentCredentials,
    catalog: Candidate[],
  ) {
    if (
      !Array.isArray(catalog) ||
      !catalog.length ||
      catalog.length > 10 ||
      !catalog.every(
        (c) =>
          typeof c.id === "string" &&
          /^[a-z0-9-]{1,40}$/.test(c.id) &&
          typeof c.address === "string" &&
          c.address.length > 0 &&
          c.address.length <= 200 &&
          /^\d{5}$/.test(c.postalCode),
      ) ||
      new Set(catalog.map((c) => c.id)).size !== catalog.length
    )
      throw Error("Explicit fictional address catalog required.");
    this.catalog = structuredClone(catalog);
    this.catalogHash = hash(this.catalog);
  }
  async handle(input: Record<string, unknown>) {
    if (
      !input ||
      Object.keys(input).sort().join(",") !==
        "action,candidateId,confirmed,expectedRevision,operationId,query,sessionToken,unit" ||
      typeof input.action !== "string" ||
      !["suggest", "confirm", "status", "clear"].includes(input.action) ||
      typeof input.sessionToken !== "string" ||
      input.sessionToken.length > 4096 ||
      typeof input.operationId !== "string" ||
      !UUID.test(input.operationId) ||
      !Number.isSafeInteger(input.expectedRevision) ||
      Number(input.expectedRevision) < 0 ||
      typeof input.query !== "string" ||
      input.query.length > 200 ||
      input.query.trim() !== input.query ||
      typeof input.unit !== "string" ||
      input.unit.length > 40 ||
      input.unit.trim() !== input.unit ||
      /[\p{Cc}\p{Cf}]/u.test(input.query + input.unit) ||
      typeof input.candidateId !== "string" ||
      typeof input.confirmed !== "boolean" ||
      (input.action === "confirm"
        ? !input.candidateId || input.confirmed !== true
        : input.candidateId !== "" || input.confirmed !== false) ||
      (input.action === "suggest" && !input.query) ||
      (["status", "clear"].includes(input.action) &&
        (input.query !== "" || input.unit !== ""))
    )
      throw new BadRequestException();
    input = { ...input };
    const token = input.sessionToken as string,
      session = this.credentials.verifySession(token);
    const digest = hash([
      session,
      input.action,
      input.operationId,
      input.expectedRevision,
      input.query,
      input.unit,
      input.candidateId,
      input.confirmed,
    ]);
    return this.prisma.$transaction(async (tx) => {
      if ((await lockCustomerConsentSession(tx, session)).status !== "ONGOING")
        throw new ConflictException();
      const rows = await tx.$queryRaw<{ value: unknown }[]>(
        Prisma.sql`SELECT "collectedData" -> 'localAddress' AS value FROM "Conversation" WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`,
      );
      if (rows.length !== 1) throw new ConflictException();
      let s: State = {
        version: 1,
        revision: 0,
        query: "",
        unit: "",
        candidates: [],
        selected: "",
        policy: "",
        lastId: "",
        lastDigest: "",
      };
      if (rows[0].value !== null) {
        if (typeof rows[0].value !== "string") throw new ConflictException();
        const raw = this.cipher.decrypt(rows[0].value);
        if (!raw) throw new ConflictException();
        s = JSON.parse(raw) as State;
        if (
          !s ||
          Object.keys(s).sort().join(",") !==
            "candidates,lastDigest,lastId,policy,query,revision,selected,unit,version" ||
          s.version !== 1 ||
          !Number.isSafeInteger(s.revision) ||
          s.revision < 1 ||
          s.revision > 20 ||
          typeof s.query !== "string" ||
          typeof s.unit !== "string" ||
          !Array.isArray(s.candidates) ||
          s.candidates.length > 10 ||
          !s.candidates.every((id) => this.catalog.some((c) => c.id === id)) ||
          typeof s.selected !== "string" ||
          (s.selected !== "" && !s.candidates.includes(s.selected)) ||
          !UUID.test(s.lastId) ||
          !/^[a-f0-9]{64}$/.test(s.lastDigest) ||
          !/^[a-f0-9]{64}$/.test(s.policy)
        )
          throw new ConflictException();
      }
      const areas = await tx.serviceArea.findMany({
        where: { tenantId: session.tenantId },
        orderBy: { id: "asc" },
        take: 1001,
      });
      if (areas.length > 1000) throw new ConflictException();
      const policy = hash([
        this.catalogHash,
        areas.map((a) => [
          a.id,
          a.type,
          a.status,
          a.definition,
          a.updatedAt.toISOString(),
        ]),
      ]);
      if (input.action === "status") {
        this.credentials.verifySession(token);
        return this.receipt(s, areas, s.revision > 0 && s.policy !== policy);
      }
      if (s.lastId === input.operationId) {
        if (s.lastDigest !== digest || s.policy !== policy)
          throw new ConflictException();
        this.credentials.verifySession(token);
        return this.receipt(s, areas, false);
      }
      if (s.revision !== input.expectedRevision || s.revision >= 20)
        throw new ConflictException();
      if (input.action === "confirm") {
        if (
          s.policy !== policy ||
          s.query !== input.query ||
          s.unit !== input.unit ||
          !s.candidates.includes(input.candidateId as string)
        )
          throw new ConflictException();
        s.selected = input.candidateId as string;
      } else {
        s.query = input.query as string;
        s.unit = input.unit as string;
        s.selected = "";
        s.candidates =
          input.action === "clear"
            ? []
            : this.catalog
                .filter((c) =>
                  c.address.toLowerCase().includes(s.query.toLowerCase()),
                )
                .map((c) => c.id);
      }
      s.revision++;
      s.policy = policy;
      s.lastId = input.operationId as string;
      s.lastDigest = digest;
      const encrypted = this.cipher.encrypt(JSON.stringify(s));
      const count = await tx.$executeRaw(
        Prisma.sql`UPDATE "Conversation" SET "collectedData"=jsonb_set("collectedData",'{localAddress}',${JSON.stringify(encrypted)}::jsonb),"updatedAt"=clock_timestamp() WHERE id=${session.conversationId}::uuid AND "tenantId"=${session.tenantId}::uuid`,
      );
      if (count !== 1) throw new ConflictException();
      await tx.auditLog.create({
        data: {
          tenantId: session.tenantId,
          entityType: "Conversation",
          entityId: session.conversationId,
          actorType: "CUSTOMER",
          actorId: "address-fixture",
          action: "conversation.local_address_changed",
          metadata: {
            revision: s.revision,
            operationId: s.lastId,
            action: input.action as string,
            fixtureOnly: true,
          },
        },
      });
      this.credentials.verifySession(token);
      return this.receipt(s, areas, false);
    });
  }
  private receipt(s: State, areas: Area[], stale: boolean) {
    const selected = this.catalog.find((c) => c.id === s.selected);
    return {
      fixtureOnly: true,
      revision: s.revision,
      stale,
      query: s.query,
      unit: s.unit,
      candidates: structuredClone(
        this.catalog.filter((c) => s.candidates.includes(c.id)),
      ),
      selectedId: stale ? "" : s.selected,
      addressState: stale
        ? "NEEDS_SELECTION"
        : selected
          ? "FIXTURE_VALIDATED"
          : s.candidates.length
            ? "NEEDS_SELECTION"
            : s.query
              ? "NEEDS_CORRECTION"
              : "NOT_CHECKED",
      coverage: stale
        ? "UNKNOWN"
        : selected
          ? localZipCoverage(areas, selected.postalCode)
          : "NOT_CHECKED",
      addressAuthorized: false,
      bookingAuthorized: false,
      deliveryAuthorized: false,
    };
  }
}
