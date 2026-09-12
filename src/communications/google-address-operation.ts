import { AddressOperationExecutor } from "./address-operation-executor";
import { AddressOperationLedger } from "./address-operation-ledger";
import { GoogleAddressRequest } from "./google-address.adapter";
import {
  GoogleAddressOAuthPorts,
  GoogleAddressOAuthTransport,
} from "./google-address-oauth.transport";

/** Inactive end-to-end fixture composition. Explicit synthetic ports required;
 * never uses the transport's default ADC/network ports. No DI/route/worker.
 * The trusted loader resolves the claimed immutable intent/revision in session
 * scope, not a browser-submitted address. No provider content leaves this seam.
 */
export class GoogleAddressOperation {
  constructor(
    private readonly fixture?: {
      mode: "FIXTURE_ONLY";
      ledger: Pick<AddressOperationLedger, "execute" | "complete">;
      ports: GoogleAddressOAuthPorts;
      readRequest: (binding: {
        sessionToken: string;
        intentId: string;
        revision: number;
      }) => Promise<GoogleAddressRequest | null>;
    },
  ) {}

  async run(input: { sessionToken: string; requestId: string }) {
    const result = (status: "DISABLED" | "OBSERVED" | "UNCERTAIN") => ({
      status,
      fixtureOnly: true as const,
      addressVerified: false as const,
      county: "UNKNOWN" as const,
      admissionAuthorized: false as const,
      deliveryAuthorized: false as const,
    });
    const fixture = this.fixture;
    if (!fixture || fixture.mode !== "FIXTURE_ONLY") return result("DISABLED");
    input = { ...input };
    const transport = new GoogleAddressOAuthTransport(true, fixture.ports);
    const executor = new AddressOperationExecutor(fixture.ledger);
    const observed = await executor.run(input, {
      mode: "FIXTURE_ONLY",
      run: async (signal, binding) => {
        if (
          !binding.intentId ||
          !Number.isSafeInteger(binding.revision) ||
          binding.revision < 1
        )
          throw Error("binding unavailable");
        const request = await fixture.readRequest({
          sessionToken: input.sessionToken,
          ...binding,
        });
        if (!request || signal.aborted) throw Error("request unavailable");
        const response = await transport.validate(request, signal);
        if (response.status !== "RESPONSE") throw Error("response unavailable");
        // Transport observation is not semantic validation or county evidence.
        // The transient body is deliberately discarded, not persisted or logged.
      },
    });
    return result(observed.status);
  }
}
