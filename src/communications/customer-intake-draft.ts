import { BadRequestException } from "@nestjs/common";

/** Customer-stated review data, NOT a CreateJobPayload or booking command. */
export type CustomerIntakeDraft = {
  customerName: string;
  phone: string;
  address: string;
  description: string;
  issueCategory: string;
  propertyType: string;
  serviceIntent: string;
};
export function validateCustomerIntakeDraft(
  value: unknown,
): CustomerIntakeDraft {
  const refuse = () => {
    throw new BadRequestException("Invalid intake draft details.");
  };
  if (!value || typeof value !== "object" || Array.isArray(value))
    return refuse();
  const draft = value as Record<string, unknown>;
  if (
    Object.keys(draft).sort().join(",") !==
    "address,customerName,description,issueCategory,phone,propertyType,serviceIntent"
  )
    return refuse();
  for (const [key, max] of Object.entries({
    customerName: 120,
    phone: 40,
    address: 200,
    description: 400,
    issueCategory: 32,
    propertyType: 16,
    serviceIntent: 16,
  })) {
    const v = draft[key];
    if (
      typeof v !== "string" ||
      !v.trim() ||
      v !== v.trim() ||
      v.length > max ||
      [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return refuse();
  }
  if (
    !/^\+[1-9][0-9]{7,14}$/.test(draft.phone as string) ||
    ![
      "HEATING",
      "COOLING",
      "PLUMBING",
      "ELECTRICAL",
      "DRAINS",
      "GENERAL",
      "BOILER",
      "REFRIGERATION",
      "COMMERCIAL_HVAC",
      "COMMERCIAL_REFRIGERATION",
    ].includes(draft.issueCategory as string) ||
    !["RESIDENTIAL", "COMMERCIAL", "MANAGED"].includes(
      draft.propertyType as string,
    ) ||
    !["DIAGNOSTIC", "REPAIR", "INSTALLATION", "MAINTENANCE", "OTHER"].includes(
      draft.serviceIntent as string,
    )
  )
    return refuse();
  return {
    customerName: draft.customerName as string,
    phone: draft.phone as string,
    address: draft.address as string,
    description: draft.description as string,
    issueCategory: draft.issueCategory as string,
    propertyType: draft.propertyType as string,
    serviceIntent: draft.serviceIntent as string,
  };
}
