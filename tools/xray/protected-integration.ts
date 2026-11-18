/** Protected-host composition contracts only; no production provider or writer registration. */
import { z } from "zod";
import { objectDigest } from "../agentic/artifacts.js";
import { safeId } from "../agentic/contracts/index.js";
import {
  journalReservationRequestSchema,
  type JournalReservationRequest,
} from "../agentic/journal-reservation.js";
import {
  humanDecisionSchema,
  TrustedHumanApprovalBoundary,
  type TrustedHumanApprovalAuthority,
} from "../agentic/approval-authority.js";
import {
  ReferencedCredentialProvider,
  XrayTokenProvider,
  type ApprovedCredentialSource,
  type CredentialProvider,
} from "./clients/authentication.js";
import {
  approvedApiBase,
  XrayReadError,
  type HttpFetch,
} from "./clients/http.js";
import { XrayHttpReadTransport } from "./clients/transport.js";
import { XrayReadClient } from "./clients/index.js";

/** References are opaque identifiers, not secret values, paths or environment variable names. */
export class ProtectedCredentialReference implements CredentialProvider {
  #base: string;
  #provider?: ReferencedCredentialProvider;
  constructor(options: {
    apiBase: string;
    reference?: string;
    source?: ApprovedCredentialSource;
    mode?: "offline" | "protected-host";
  }) {
    this.#base = approvedApiBase(options.apiBase);
    if (
      options.reference !== undefined &&
      !safeId.safeParse(options.reference).success
    )
      throw new XrayReadError("INVALID_INPUT");
    if (
      options.mode === "protected-host" &&
      options.reference &&
      options.source
    )
      this.#provider = new ReferencedCredentialProvider(
        options.reference,
        options.source,
      );
  }
  async resolve(apiBase: string) {
    if (approvedApiBase(apiBase) !== this.#base)
      throw new XrayReadError("INVALID_ENDPOINT");
    if (!this.#provider) throw new XrayReadError("CREDENTIALS_UNAVAILABLE");
    return this.#provider.resolve(this.#base);
  }
  toJSON() {
    return { type: "ProtectedCredentialReference" };
  }
}

/** Reuses the existing authentication/read transport. No writer, raw token or diagnostics exposed.
 * The protected host must supply its transport explicitly. Offline is default and resolves nothing.
 * Existing read-only 401 refresh semantics remain; this composition must never carry mutations.
 */
export function protectedReadSession(options: {
  apiBase: string;
  reference?: string;
  source?: ApprovedCredentialSource;
  mode?: "offline" | "protected-host";
  fetch?: HttpFetch;
}) {
  const base = approvedApiBase(options.apiBase);
  const offline: HttpFetch = async () => {
    throw new XrayReadError("CREDENTIALS_UNAVAILABLE");
  };
  const fetcher =
    options.mode === "protected-host" && options.fetch
      ? options.fetch
      : offline;
  const credentials = new ProtectedCredentialReference({
    ...options,
    mode:
      options.mode === "protected-host" && options.fetch
        ? "protected-host"
        : "offline",
  });
  const tokens = new XrayTokenProvider({
    apiBase: base,
    credentials,
    fetch: fetcher,
  });
  const client = new XrayReadClient(
    new XrayHttpReadTransport({
      apiBase: base,
      tokens,
      fetch: fetcher,
      retries: 0,
    }),
  );
  return Object.freeze({
    client,
    close: () => tokens.invalidate(),
    productionExecution: "BLOCKED" as const,
  });
}

const contextSchema = z
  .object({
    authorityId: safeId,
    tenant: z.string().min(1),
    projectKey: z.string().regex(/^[A-Z][A-Z0-9]*$/),
    executorPrincipal: z.string().min(1),
    authorityEpoch: safeId,
  })
  .strict();
const observationSchema = z
  .object({
    authorityId: safeId,
    decisionId: safeId,
    requestDigest: z.string(),
    subject: z.string().min(1),
    authenticationReference: safeId,
    authenticatedAt: z.string().datetime(),
    active: z.literal(true),
  })
  .strict();
/** Independently trusted protected-host service, not a decision JSON parser.
 * Must verify the authenticated source/session and binding, with current revocation checks.
 * No implementation is supplied here. An editable file cannot implement this trust boundary.
 */
export interface AuthenticatedApproverVerifier {
  verifyAuthenticatedApprover(binding: {
    authorityId: string;
    decisionId: string;
    requestDigest: string;
    subject: string;
    authenticationReference: string;
  }): Promise<unknown>;
}

/** Adapts existing authority contracts; the existing boundary/journal own durable reservations.
 * Injection is a host trust dependency, not proof that any real human has authenticated.
 */
export class ProtectedAuthorityAdapter implements TrustedHumanApprovalAuthority {
  readonly authorityId: string;
  #context: z.infer<typeof contextSchema>;
  #source?: TrustedHumanApprovalAuthority;
  #identities?: AuthenticatedApproverVerifier;
  #now: () => number;
  #verified = new Map<string, JournalReservationRequest>();
  #attempted = new Set<string>();
  constructor(
    context: z.infer<typeof contextSchema>,
    dependencies: {
      source?: TrustedHumanApprovalAuthority;
      identities?: AuthenticatedApproverVerifier;
      now?: () => number;
    } = {},
  ) {
    this.#context = contextSchema.parse(structuredClone(context));
    this.authorityId = this.#context.authorityId;
    this.#source = dependencies.source;
    this.#identities = dependencies.identities;
    this.#now = dependencies.now ?? Date.now;
  }
  boundary() {
    return new TrustedHumanApprovalBoundary(this, this.#now);
  }
  async verify(
    reference: string,
    raw: JournalReservationRequest,
    requestDigest: string,
  ) {
    try {
      safeId.parse(reference);
      const request = journalReservationRequestSchema.parse(
        structuredClone(raw),
      );
      if (
        !this.#source ||
        !this.#identities ||
        this.#source.authorityId !== this.authorityId ||
        request.tenant !== this.#context.tenant ||
        request.projectKey !== this.#context.projectKey ||
        request.executorPrincipal !== this.#context.executorPrincipal ||
        request.authorityEpoch !== this.#context.authorityEpoch ||
        objectDigest(request) !== requestDigest
      )
        throw new Error();
      const decision = humanDecisionSchema.parse(
        await this.#source.verify(
          reference,
          structuredClone(request),
          requestDigest,
        ),
      );
      if (
        decision.authorityId !== this.authorityId ||
        decision.approvalId !== reference ||
        decision.requestDigest !== requestDigest ||
        objectDigest(decision.request) !== requestDigest ||
        decision.humanReference !== decision.approver.subject ||
        decision.decision === "denied" ||
        Date.parse(decision.issuedAt) > this.#now() ||
        Date.parse(decision.approver.authenticatedAt) >
          Date.parse(decision.issuedAt) ||
        (decision.decision === "approved" &&
          (Date.parse(decision.expiresAt) <= this.#now() ||
            Date.parse(decision.expiresAt) <= Date.parse(decision.issuedAt)))
      )
        throw new Error();
      const binding = {
        authorityId: this.authorityId,
        decisionId: decision.decisionId,
        requestDigest,
        subject: decision.approver.subject,
        authenticationReference: decision.approver.authenticationReference,
      };
      const identity = observationSchema.parse(
        await this.#identities.verifyAuthenticatedApprover(
          Object.freeze({ ...binding }),
        ),
      );
      if (
        Object.entries(binding).some(
          ([key, value]) => identity[key as keyof typeof binding] !== value,
        ) ||
        identity.authenticatedAt !== decision.approver.authenticatedAt
      )
        throw new Error();
      this.#verified.set(reference, request);
      return decision;
    } catch {
      this.#verified.delete(reference);
      throw new Error("PROTECTED_AUTHORITY_UNAVAILABLE_OR_INVALID");
    }
  }
  async consumeApproval(
    reference: string,
    requestDigest: string,
    reservationId: string,
  ) {
    // Poison before any await. Durable journal guards duplicates across adapter/process restarts.
    if (this.#attempted.has(reference))
      throw new Error("PROTECTED_AUTHORITY_RECONCILIATION_REQUIRED");
    this.#attempted.add(reference);
    try {
      safeId.parse(reservationId);
      const request = this.#verified.get(reference);
      if (!request || objectDigest(request) !== requestDigest)
        throw new Error();
      const decision = await this.verify(reference, request, requestDigest);
      if (decision.decision !== "approved") throw new Error();
      return await this.#source!.consumeApproval(
        reference,
        requestDigest,
        reservationId,
      );
    } catch {
      throw new Error("PROTECTED_AUTHORITY_CONSUMPTION_UNCERTAIN");
    }
  }
  async revokeApproval(): Promise<never> {
    throw new Error("PROTECTED_AUTHORITY_ADMIN_UNAVAILABLE");
  }
  async readAudit(): Promise<never> {
    throw new Error("PROTECTED_AUTHORITY_AUDIT_PROVIDER_UNAVAILABLE");
  }
  toJSON() {
    return {
      type: "ProtectedAuthorityAdapter",
      productionExecution: "BLOCKED",
    };
  }
}
