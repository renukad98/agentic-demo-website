import type { ReadTransport } from "./index.js";
import type { TokenProvider } from "./authentication.js";
import { readOperation, validateReadData } from "./operations.js";
import {
  approvedApiBase,
  boundedTimeout,
  correlationId,
  diagnose,
  postJson,
  withTimeout,
  XrayReadError,
  type HttpFetch,
  type DiagnosticSink,
} from "./http.js";

export interface ReadOnlyTransportOptions {
  apiBase: string;
  tokens: TokenProvider;
  fetch?: HttpFetch;
  timeoutMs?: number;
  retries?: number;
  diagnostics?: DiagnosticSink;
}
export class XrayHttpReadTransport implements ReadTransport {
  #base: string;
  #tokens: TokenProvider;
  #fetch: HttpFetch;
  #timeout: number;
  #retries: number;
  #diagnostics?: DiagnosticSink;
  constructor(options: ReadOnlyTransportOptions) {
    this.#base = approvedApiBase(options.apiBase);
    this.#tokens = options.tokens;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = boundedTimeout(options.timeoutMs);
    this.#retries = options.retries ?? 1;
    if (
      !Number.isInteger(this.#retries) ||
      this.#retries < 0 ||
      this.#retries > 2
    )
      throw new XrayReadError("INVALID_INPUT");
    this.#diagnostics = options.diagnostics;
  }
  async request(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<unknown> {
    const operation = readOperation(query, variables); // Reject before credentials or network.
    const id = correlationId();
    let refreshed = false;
    let retries = 0;
    for (let attempt = 0; ; attempt++) {
      let token: string | undefined;
      try {
        token = await withTimeout(
          () => this.#tokens.getToken(this.#base),
          this.#timeout,
          id,
        );
        if (!token || !/^[A-Za-z0-9._-]+$/.test(token))
          throw new XrayReadError("INVALID_TOKEN", undefined, id);
        const value = await postJson(
          this.#fetch,
          this.#base,
          "/api/v2/graphql",
          { query, variables: operation.variables },
          this.#timeout,
          id,
          token,
        );
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new XrayReadError("MALFORMED_RESPONSE", undefined, id);
        const result = value as Record<string, unknown>;
        if (result.errors !== undefined) {
          if (!Array.isArray(result.errors))
            throw new XrayReadError("MALFORMED_RESPONSE", undefined, id);
          if (result.errors.length)
            throw new XrayReadError("GRAPHQL", undefined, id); // Never echo server messages/extensions.
        }
        if (
          !result.data ||
          typeof result.data !== "object" ||
          Array.isArray(result.data) ||
          !(operation.field in result.data)
        )
          throw new XrayReadError("MALFORMED_RESPONSE", undefined, id);
        const data = validateReadData(
          operation.name,
          result.data,
          operation.variables,
        );
        diagnose(this.#diagnostics, {
          correlationId: id,
          operation: operation.name,
          attempt,
          outcome: "success",
        });
        return { data };
      } catch (error) {
        const safe =
          error instanceof XrayReadError
            ? error
            : new XrayReadError("NETWORK", undefined, id);
        let retry = false;
        if (safe.code === "UNAUTHORIZED" && token && !refreshed) {
          this.#tokens.invalidate(token);
          refreshed = true;
          retry = true;
        } else if (
          ["NETWORK", "TIMEOUT"].includes(safe.code) ||
          (safe.code === "HTTP" && [502, 503, 504].includes(safe.status ?? 0))
        ) {
          if (retries < this.#retries) {
            retries++;
            retry = true;
          }
        }
        diagnose(this.#diagnostics, {
          correlationId: id,
          operation: operation.name,
          attempt,
          outcome: retry ? "retry" : "failed",
          code: safe.code,
          status: safe.status,
        });
        if (!retry) throw safe;
        // Bounded backoff; rate-limit responses are surfaced instead of hammered.
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  toJSON() {
    return {
      type: "XrayHttpReadTransport",
      apiBase: this.#base,
      remoteWritesEnabled: false,
    };
  }
}
