import { BadRequestException } from "@nestjs/common";
import { validateCustomerIntakeDraft } from "./customer-intake-draft";
import { reviewGoogleAddressResponse } from "./google-address.adapter";

/** Customer-confirmed input only. No proof, policy or service authority. */
export function controlledIntakeSubmission(value: unknown) {
  const refuse = () =>
    new BadRequestException("Invalid controlled intake submission.");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw refuse();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
      "confirmed,confirmedAddress,draft,expectedRevision,requestId,sessionToken,version" ||
    v.version !== 2 ||
    v.confirmed !== true ||
    typeof v.sessionToken !== "string" ||
    !v.sessionToken ||
    v.sessionToken.length > 4096 ||
    typeof v.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      v.requestId,
    ) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    Number(v.expectedRevision) < 1 ||
    Number(v.expectedRevision) > 20 ||
    reviewGoogleAddressResponse(v.confirmedAddress, null).status ===
      "INVALID_INPUT"
  )
    throw refuse();
  const a = v.confirmedAddress as {
    street: string;
    unit: string;
    city: string;
    postalCode: string;
  };
  const address = Object.freeze({
    street: a.street,
    unit: a.unit,
    city: a.city,
    postalCode: a.postalCode,
  });
  const draft = validateCustomerIntakeDraft(v.draft);
  const display = `${address.street}${address.unit ? ", " + address.unit : ""}, ${address.city}, OH ${address.postalCode}`;
  if (draft.address !== display || !/^\+1[2-9]\d{9}$/.test(draft.phone))
    throw refuse();
  return Object.freeze({
    version: 2 as const,
    sessionToken: v.sessionToken,
    requestId: v.requestId,
    expectedRevision: v.expectedRevision as number,
    confirmed: true as const,
    draft: Object.freeze(draft),
    confirmedAddress: address,
  });
}
export type ControlledIntakeRequest = ReturnType<
  typeof controlledIntakeSubmission
>;
