// Explicit mock policy; trusted organization version is read under the caller's session lock.
export async function localFreshnessPolicy(tx, tenantId) {
  const row = await tx.tenantOrganization.findUnique({
    where: { id: tenantId },
    select: { settings: true },
  });
  const approved = row?.settings?.organizationProfileV1?.approved?.approvedAt;
  if (typeof approved !== "string" || !Number.isFinite(Date.parse(approved)))
    return null;
  return {
    mode: "FIXTURE_ONLY",
    version: "1A-30m-v1",
    lifetimeMs: 1800000,
    noticeVersion: "local-verification-v1",
    sourceVersion: "mock-v1",
    businessPolicyVersion: approved,
  };
}
