// In-memory review only. No I/O, cache, persistence or provenance conversion.
export async function semanticReview(request, body, parsers, now = Date.now()) {
  const input = {
    street: request.address.addressLines[0],
    unit: request.address.addressLines[1] ?? '',
    city: request.address.locality, postalCode: request.address.postalCode,
  };
  const parsed = parsers.address(input, body);
  const binding = { tenantId:'local-owner-inspection', sessionId:'semantic-002',
    addressRevision:1, policyVersion:'google-only-review-20260912' };
  const coverage = await parsers.county(input, body, {
    current: binding, confirmed: { ...binding }, customerConfirmed:true,
    checkedAt:now, now, expiresAt:now+60000,
  }, 'REVIEW_ONLY');
  // Fixed enums only, never echo provider-controlled text or correction address.
  const address = ['REVIEW','CORRECTION_REQUIRED','UNKNOWN','INVALID_INPUT'].includes(parsed.status)
    ? parsed.status : 'UNKNOWN';
  const area = ['IN_AREA','OUT_OF_AREA','UNKNOWN'].includes(coverage.coverage)
    ? coverage.coverage : 'UNKNOWN';
  return 'Address review: '+address+'\nService-area review: '+area+
    '\nLocal inspection only. No real admission, job, booking, payment or delivery authorized.'+
    '\nResults are not saved. Corrections require a separately approved flow.';
}
