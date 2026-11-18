import { proposalSchema } from "../agentic/contracts/index.js";
import { objectDigest } from "../agentic/artifacts.js";

export class Publisher {
  readonly remoteWritesEnabled = false;
  async publish(raw: unknown): Promise<never> {
    const proposal = proposalSchema.parse(raw);
    if (objectDigest(proposal.payload) !== proposal.payloadDigest)
      throw new Error("Payload digest mismatch");
    throw new Error(
      "Remote publication disabled in Phase 5D; approval cannot enable it",
    );
  }
}
