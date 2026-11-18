import { z } from "zod";
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

const credentialsSchema = z
  .object({
    clientId: z.string().min(1).max(1024),
    clientSecret: z.string().min(1).max(4096),
  })
  .strict();
export type XrayCredentials = z.infer<typeof credentialsSchema>;
export interface CredentialProvider {
  resolve(apiBase: string): Promise<XrayCredentials>;
}
export interface ApprovedCredentialSource {
  /** The embedding host must enforce adapter/tenant/region authorization, not trust a local JSON flag. */
  resolveApprovedReference(
    reference: string,
    audience: string,
  ): Promise<unknown>;
}
export class ReferencedCredentialProvider implements CredentialProvider {
  #source: ApprovedCredentialSource;
  #reference: string;
  constructor(reference: string, source: ApprovedCredentialSource) {
    if (!reference.trim() || reference.length > 256)
      throw new XrayReadError("INVALID_INPUT");
    this.#reference = reference;
    this.#source = source;
  }
  async resolve(apiBase: string) {
    const base = approvedApiBase(apiBase);
    let value: unknown;
    try {
      value = await this.#source.resolveApprovedReference(
        this.#reference,
        base,
      );
    } catch {
      throw new XrayReadError("CREDENTIALS_UNAVAILABLE");
    }
    const parsed = credentialsSchema.safeParse(value);
    if (!parsed.success) throw new XrayReadError("INVALID_CREDENTIALS");
    return parsed.data;
  }
  toJSON() {
    return { type: "ReferencedCredentialProvider", configured: true };
  }
}
export const unavailableCredentials: CredentialProvider = {
  async resolve() {
    throw new XrayReadError("CREDENTIALS_UNAVAILABLE");
  },
};
export interface TokenProvider {
  getToken(apiBase: string): Promise<string>;
  invalidate(rejectedToken?: string): void;
}
export interface AuthenticationOptions {
  apiBase: string;
  credentials?: CredentialProvider;
  fetch?: HttpFetch;
  timeoutMs?: number;
  now?: () => number;
  diagnostics?: DiagnosticSink;
}
export class XrayTokenProvider implements TokenProvider {
  #base: string;
  #credentials: CredentialProvider;
  #fetch: HttpFetch;
  #timeout: number;
  #now: () => number;
  #diagnostics?: DiagnosticSink;
  #cached?: { token: string; expiresAt: number };
  #pending?: Promise<string>;
  #generation = 0;
  constructor(options: AuthenticationOptions) {
    this.#base = approvedApiBase(options.apiBase);
    this.#credentials = options.credentials ?? unavailableCredentials;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = boundedTimeout(options.timeoutMs);
    this.#now = options.now ?? Date.now;
    this.#diagnostics = options.diagnostics;
  }
  invalidate(rejectedToken?: string) {
    if (rejectedToken && this.#cached?.token !== rejectedToken) return;
    this.#cached = undefined;
    this.#generation++;
  }
  async getToken(apiBase: string): Promise<string> {
    if (approvedApiBase(apiBase) !== this.#base)
      throw new XrayReadError("INVALID_ENDPOINT");
    if (this.#cached && this.#now() < this.#cached.expiresAt - 60000)
      return this.#cached.token;
    if (this.#pending) return this.#pending;
    const generation = this.#generation;
    const pending = this.authenticate(generation);
    this.#pending = pending;
    try {
      return await pending;
    } finally {
      if (this.#pending === pending) this.#pending = undefined;
    }
  }
  private async authenticate(generation: number): Promise<string> {
    const id = correlationId();
    try {
      let credentials: XrayCredentials;
      try {
        credentials = credentialsSchema.parse(
          await withTimeout(
            () => this.#credentials.resolve(this.#base),
            this.#timeout,
            id,
          ),
        );
      } catch (error) {
        if (error instanceof XrayReadError) throw error;
        throw new XrayReadError("INVALID_CREDENTIALS", undefined, id);
      }
      const started = this.#now();
      const response = await postJson(
        this.#fetch,
        this.#base,
        "/api/v2/authenticate",
        {
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        },
        this.#timeout,
        id,
      );
      // Xray returns a JSON string. Treat JWT exp only as a cache bound, never as authorization proof.
      if (
        typeof response !== "string" ||
        response.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(response)
      )
        throw new XrayReadError("INVALID_TOKEN", undefined, id);
      let exp: unknown;
      try {
        exp = JSON.parse(
          Buffer.from(response.split(".")[1]!, "base64url").toString("utf8"),
        ).exp;
      } catch {
        throw new XrayReadError("INVALID_TOKEN", undefined, id);
      }
      if (
        typeof exp !== "number" ||
        !Number.isFinite(exp) ||
        exp * 1000 <= started + 60000
      )
        throw new XrayReadError("INVALID_TOKEN", undefined, id);
      const expiresAt = Math.min(exp * 1000, started + 24 * 60 * 60 * 1000);
      if (generation !== this.#generation)
        throw new XrayReadError("AUTH_FAILED", undefined, id);
      this.#cached = { token: response, expiresAt };
      diagnose(this.#diagnostics, {
        correlationId: id,
        operation: "authenticate",
        attempt: 0,
        outcome: "success",
      });
      return response;
    } catch (error) {
      const safe =
        error instanceof XrayReadError
          ? error
          : new XrayReadError("AUTH_FAILED", undefined, id);
      diagnose(this.#diagnostics, {
        correlationId: id,
        operation: "authenticate",
        attempt: 0,
        outcome: "failed",
        code: safe.code,
        status: safe.status,
      });
      throw safe;
    }
  }
  toJSON() {
    return { type: "XrayTokenProvider", apiBase: this.#base };
  }
}
