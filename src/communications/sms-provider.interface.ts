export const SMS_PROVIDER = Symbol("SMS_PROVIDER");

export interface SmsProviderRequest {
  from: string;
  to: string;
  body: string;
  statusCallback: string;
}

export interface SmsProviderResult {
  externalId: string;
  status: string;
}

export class SmsProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly safeToRetry: boolean,
  ) {
    super(message);
  }
}

export interface SmsProvider {
  send(request: SmsProviderRequest): Promise<SmsProviderResult>;
}
