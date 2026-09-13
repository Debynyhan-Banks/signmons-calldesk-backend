// Shared parser -> transient presentation. No provider call or durable receipt.
export function correctionReview(request, body, parse) {
  const entered = {
    street: request.address.addressLines[0],
    unit: request.address.addressLines[1] ?? "",
    city: request.address.locality,
    postalCode: request.address.postalCode,
  };
  const result = parse(entered, body);
  if (result.status !== "CORRECTION_REQUIRED" || !result.candidate) return null;
  return { entered, candidate: structuredClone(result.candidate) };
}

export async function presentObservedCorrection(status, review, present) {
  if (status !== "OBSERVED" || !review) return "NOT_PRESENTED";
  // Selection is deliberately not an admission proof or a second request.
  const selection = await present(review.entered, review.candidate);
  return [
    "CONFIRMED",
    "EDITED",
    "CANCELLED",
    "EXPIRED",
    "REFUSED",
    "UNAVAILABLE",
  ].includes(selection?.status)
    ? selection.status
    : "REFUSED";
}
