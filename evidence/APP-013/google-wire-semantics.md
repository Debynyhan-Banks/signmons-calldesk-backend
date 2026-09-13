# Google wire semantics correction

2026-09-12: progressed address/county qualification without another provider request. Google official [accept-address examples](https://developers.google.com/maps/documentation/address-validation/accept-address-example) show fipsCountyCode as "085". Thus three-digit, leading-zero format has published example support; it is no longer solely our fixture hypothesis. This does not guarantee availability for every address or qualify the pilot address.

Google's [USPS schema](https://raw.githubusercontent.com/googleapis/googleapis/master/google/maps/addressvalidation/v1/usps_data.proto) declares po_box_only_postal_code as an implicit-presence proto3 boolean. [ProtoJSON rules](https://protobuf.dev/programming-guides/json/#presence-and-default-values) omit default-valued implicit fields. Evaluator now accepts omitted or false for this scalar; true and malformed values still refuse. This removes a false-negative parser condition, not an address safety requirement.

Optional metadata.poBox still requires explicit false; absent optional evidence remains UNKNOWN. County/state/country, explicit DPV and mailbox signals, confirmed address/unit and current bindings remain required. Null remains rejected conservatively even though general ProtoJSON readers can accept null. No broader normalization or output/persistence/authority change.

Seven added cases cover omitted scalar, still-unknown optional metadata and malformed scalar values. All existing negative cases remain. No live test, new packet, removal of retained claim, API/configuration/IAM change, deployment or billing action. No UI/route change; browser QA not applicable.

Final validation: 112 suites / 2,142 tests passed, three existing skips; lint, build/Prisma generation, architecture, cross-repository governance consistency, eight governance regressions and whitespace passed.

Next: resolve remaining permitted in-process semantic inspection and correction-sequence handling before a separately approved semantic test. The prior connectivity test cannot be replayed and its body was discarded. Do not claim full 2B acceptance or rebuild another generic evaluator. APP-013/2B Now; walkthrough 3/8 (37.5%) unchanged.
