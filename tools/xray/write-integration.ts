import { trustedApprovalRequestSchema } from "../agentic/contracts/index.js";
import { objectDigest } from "../agentic/artifacts.js";

/** Additive contract: old planning receipts remain readable, executors require identity. */
export const writeApprovalRequestSchema = trustedApprovalRequestSchema.required(
  {
    automationIdentity: true,
  },
);

export interface GenericMutationTransport {
  create(payload: unknown): Promise<unknown>;
}
export interface JiraLinkTransport {
  link(payload: unknown): Promise<void>;
}

/** Stable per tenant/project/operation/payload. Retries need reviewed reconciliation. */
export function writeOperationId(context: {
  tenant: string;
  projectKey: string;
  operation:
    | "xray.test.create"
    | "jira.test.link"
    | "xray.execution.create"
    | "xray.results.import";
  payloadDigest: string;
}) {
  return `write-${objectDigest(context).slice(7)}`;
}

/** No registrations, flags, authority, credentials or transport accepted here. */
export function createProductionWriteExecutor(): never {
  throw new Error("PRODUCTION_WRITES_DISABLED");
}
