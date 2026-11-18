import { randomUUID } from "node:crypto";
import { XrayReadError, type ErrorCode } from "./errors.js";
import { readOperation } from "./operations.js";
export { XrayReadError, type ErrorCode } from "./errors.js";

export const apiRegions = {
  global: "https://xray.cloud.getxray.app",
  us: "https://us.xray.cloud.getxray.app",
  eu: "https://eu.xray.cloud.getxray.app",
  au: "https://au.xray.cloud.getxray.app",
} as const;
Object.freeze(apiRegions);
export function approvedApiBase(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XrayReadError("INVALID_ENDPOINT");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !Object.values(apiRegions).includes(
      url.origin as (typeof apiRegions)[keyof typeof apiRegions],
    )
  )
    throw new XrayReadError("INVALID_ENDPOINT");
  return url.origin;
}
export type HttpFetch = typeof globalThis.fetch;
export interface Diagnostic {
  correlationId: string;
  operation: string;
  attempt: number;
  outcome: "success" | "retry" | "failed";
  code?: ErrorCode;
  status?: number;
}
export type DiagnosticSink = (event: Readonly<Diagnostic>) => void;
export function diagnose(sink: DiagnosticSink | undefined, event: Diagnostic) {
  // Only locally generated IDs, allowlisted operation names, numeric status and fixed codes.
  try {
    sink?.(Object.freeze({ ...event }));
  } catch {
    /* diagnostics cannot change request behavior */
  }
}
export function boundedTimeout(value = 10000) {
  if (!Number.isInteger(value) || value < 1 || value > 60000)
    throw new XrayReadError("INVALID_INPUT");
  return value;
}
export function correlationId() {
  return randomUUID();
}
export async function withTimeout<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  id: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new XrayReadError("TIMEOUT", undefined, id)),
      boundedTimeout(timeoutMs),
    );
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function limitedJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const length = response.headers.get("content-length");
  if (length && Number(length) > maxBytes)
    throw new XrayReadError("RESPONSE_TOO_LARGE");
  if (!response.body) throw new XrayReadError("MALFORMED_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw new XrayReadError("RESPONSE_TOO_LARGE");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    if (error instanceof XrayReadError) throw error;
    throw new XrayReadError("MALFORMED_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}
/** Timeout covers headers and body; error bodies are never read or echoed. */
export async function postJson(
  fetcher: HttpFetch,
  apiBase: string,
  path: "/api/v2/authenticate" | "/api/v2/graphql",
  body: unknown,
  timeoutMs: number,
  id: string,
  token?: string,
): Promise<unknown> {
  const base = approvedApiBase(apiBase);
  if (path !== "/api/v2/authenticate" && path !== "/api/v2/graphql")
    throw new XrayReadError("UNSUPPORTED_OPERATION");
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new XrayReadError("INVALID_INPUT");
  const fields = body as Record<string, unknown>;
  if (path === "/api/v2/graphql") {
    if (
      Object.keys(fields).sort().join(",") !== "query,variables" ||
      typeof fields.query !== "string" ||
      !fields.variables ||
      typeof fields.variables !== "object" ||
      Array.isArray(fields.variables)
    )
      throw new XrayReadError("UNSUPPORTED_OPERATION");
    readOperation(fields.query, fields.variables as Record<string, unknown>);
  } else if (
    token ||
    Object.keys(fields).sort().join(",") !== "client_id,client_secret" ||
    typeof fields.client_id !== "string" ||
    !fields.client_id ||
    typeof fields.client_secret !== "string" ||
    !fields.client_secret
  )
    throw new XrayReadError("INVALID_CREDENTIALS");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new XrayReadError("TIMEOUT", undefined, id));
    }, boundedTimeout(timeoutMs));
  });
  const request = async () => {
    let response: Response;
    try {
      response = await fetcher(`${base}${path}`, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-request-id": id,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new XrayReadError(
        controller.signal.aborted ? "TIMEOUT" : "NETWORK",
        undefined,
        id,
      );
    }
    if (
      response.redirected ||
      (response.url && response.url !== `${base}${path}`) ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new XrayReadError("REDIRECT", response.status, id);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new XrayReadError(
        response.status === 401 ? "UNAUTHORIZED" : "HTTP",
        response.status,
        id,
      );
    }
    if (
      !/^application\/(?:json|graphql-response\+json)(?:\s*;|$)/i.test(
        response.headers.get("content-type") ?? "",
      )
    )
      throw new XrayReadError("MALFORMED_RESPONSE", undefined, id);
    return limitedJson(response, 1024 * 1024);
  };
  try {
    return await Promise.race([request(), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}
