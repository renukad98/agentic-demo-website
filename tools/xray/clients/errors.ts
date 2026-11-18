export type ErrorCode =
  | "INVALID_ENDPOINT"
  | "INVALID_INPUT"
  | "CREDENTIALS_UNAVAILABLE"
  | "INVALID_CREDENTIALS"
  | "AUTH_FAILED"
  | "INVALID_TOKEN"
  | "TIMEOUT"
  | "NETWORK"
  | "HTTP"
  | "UNAUTHORIZED"
  | "REDIRECT"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "GRAPHQL"
  | "UNSUPPORTED_OPERATION"
  | "PAGINATION";
export class XrayReadError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status?: number,
    readonly correlationId?: string,
  ) {
    super(
      `Xray read-only adapter: ${code}${status === undefined ? "" : ` (HTTP ${status})`}`,
    );
    this.name = "XrayReadError";
  }
}
