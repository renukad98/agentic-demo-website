import { readFile } from "node:fs/promises";
import { z } from "zod";
import { identitySchema, type Identity } from "../agentic/contracts/index.js";
import {
  writeExclusive,
  within,
  noSymlinks,
  objectDigest,
  fingerprint,
} from "../agentic/artifacts.js";

export const identityKey = (identity: Identity) =>
  `${identity.repository}:${identity.runner}:${identity.automationId}`;
const registrySchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    identities: z.array(identitySchema),
  })
  .strict();
export class IdentityRegistry {
  private entries = new Map<string, Identity>();
  register(raw: unknown): Identity {
    const candidate = identitySchema.parse(raw);
    const key = identityKey(candidate);
    const prior = this.entries.get(key);
    if (candidate.binding) validateBinding(candidate);
    if (
      prior &&
      (prior.behaviorDigest !== candidate.behaviorDigest ||
        prior.parameterIdentity !== candidate.parameterIdentity)
    )
      throw new Error("Identity behavior changed; review required");
    if (
      prior &&
      (prior.sourceLocation !== candidate.sourceLocation ||
        prior.sourceDigest !== candidate.sourceDigest ||
        objectDigest(prior.binding ?? null) !==
          objectDigest(candidate.binding ?? null))
    )
      throw new Error("Identity binding changed; reviewed migration required");
    for (const existing of this.entries.values()) {
      if (identityKey(existing) === key) continue;
      if (
        existing.repository === candidate.repository &&
        existing.runner === candidate.runner &&
        existing.binding &&
        candidate.binding &&
        (existing.binding.runnerIds.some((id) =>
          candidate.binding!.runnerIds.includes(id),
        ) ||
          (existing.sourceLocation === candidate.sourceLocation &&
            existing.binding.testTitle === candidate.binding.testTitle &&
            existing.binding.projectName === candidate.binding.projectName))
      )
        throw new Error("Conflicting automation binding");
      if (
        existing.xray &&
        candidate.xray &&
        (existing.xray.key === candidate.xray.key ||
          existing.xray.issueId === candidate.xray.issueId)
      )
        throw new Error("Xray Test already mapped to another identity");
    }
    if (
      candidate.xray &&
      candidate.xray.behaviorDigest !== candidate.behaviorDigest
    )
      throw new Error("Unverified behavior mapping");
    if (
      prior?.xray &&
      candidate.xray &&
      (prior.xray.key !== candidate.xray.key ||
        prior.xray.issueId !== candidate.xray.issueId)
    )
      throw new Error("Ambiguous Xray identity");
    const merged: Identity = {
      ...candidate,
      xray: candidate.xray ?? prior?.xray,
      associations: [
        ...new Map(
          [...(prior?.associations ?? []), ...candidate.associations].map(
            (a) => [objectDigest(a), a],
          ),
        ).values(),
      ],
    };
    this.entries.set(key, merged);
    return structuredClone(merged);
  }
  list() {
    return structuredClone([...this.entries.values()]);
  }
  resolveRunner(
    repository: string,
    runner: Identity["runner"],
    runnerId: string,
    story: string,
  ): Identity {
    const matches = this.list().filter(
      (identity) =>
        identity.repository === repository &&
        identity.runner === runner &&
        identity.binding?.runnerIds.includes(runnerId),
    );
    if (
      matches.length !== 1 ||
      !matches[0]!.associations.some(
        (association) => association.storyKey === story,
      )
    )
      throw new Error("Missing or ambiguous Story identity binding");
    return matches[0]!;
  }
  async save(root: string, revision: string) {
    if (!/^[A-Za-z0-9_-]+$/.test(revision))
      throw new Error("Invalid registry revision");
    await writeExclusive(root, `registry-${revision}.json`, {
      schemaVersion: "1.0.0",
      identities: this.list(),
    });
  }
  static async load(root: string, filename: string) {
    const path = within(root, filename);
    await noSymlinks(root, path);
    const data = registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
    const registry = new IdentityRegistry();
    for (const identity of data.identities) registry.register(identity);
    return registry;
  }
}

export function bindingBehaviorDigest(
  identity: Pick<Identity, "sourceLocation" | "binding">,
): string {
  if (!identity.binding) throw new Error("Durable identity binding required");
  const { framework, projectName, testTitle, sourceFiles } = identity.binding;
  return objectDigest({
    sourceLocation: identity.sourceLocation,
    framework,
    projectName: projectName ?? null,
    testTitle,
    sourceFiles,
  });
}
export function bindingEvidenceDigest(identity: Identity): string {
  if (!identity.binding) throw new Error("Durable identity binding required");
  return objectDigest(identity.binding.historicalExecutions);
}
export function validateBinding(identity: Identity) {
  const binding = identity.binding;
  if (
    !binding ||
    (identity.runner === "playwright"
      ? binding.framework !== "playwright"
      : binding.framework !== "node:test")
  )
    throw new Error("Durable identity binding required");
  if (binding.framework === "playwright" && !binding.projectName)
    throw new Error("Playwright project binding required");
  if (
    new Set(
      binding.historicalExecutions.map(
        (run) => `${run.runId}:${run.artifactPath}`,
      ),
    ).size !== binding.historicalExecutions.length
  )
    throw new Error("Duplicate historical execution binding");
  if (
    !binding.sourceFiles[identity.sourceLocation] ||
    objectDigest(binding.sourceFiles) !== identity.sourceDigest ||
    bindingBehaviorDigest(identity) !== identity.behaviorDigest
  )
    throw new Error("Source/behavior binding fingerprint mismatch");
  if (
    new Set(binding.runnerIds).size !== binding.runnerIds.length ||
    binding.runnerIds.some(
      (id) => !binding.historicalExecutions.some((run) => run.runnerId === id),
    )
  )
    throw new Error("Duplicate or unproven runner identity");
  if (
    binding.historicalExecutions.some(
      (run) =>
        !binding.runnerIds.includes(run.runnerId) ||
        run.testTitle !== binding.testTitle ||
        run.projectName !== binding.projectName,
    )
  )
    throw new Error("Historical binding mismatch");
  return binding;
}
function safeBindingPath(root: string, path: string) {
  if (
    (!/^(?:src|tests|public|views|tools|docs|artifacts\/qa)\//.test(path) &&
      !/^(?:package(?:-lock)?\.json|playwright\.config\.ts|tsconfig(?:\.[A-Za-z0-9_-]+)?\.json)$/.test(
        path,
      )) ||
    path
      .split(/[\\/]/)
      .some(
        (part) => part === ".." || part.startsWith(".env") || part === ".git",
      )
  )
    throw new Error("Unsafe identity fingerprint path");
  return within(root, path);
}
export async function verifyBinding(
  root: string,
  raw: Identity,
): Promise<{ sourceDigest: string; evidenceDigest: string }> {
  const identity = identitySchema.parse(raw);
  const binding = validateBinding(identity);
  for (const [path, expected] of Object.entries(binding.sourceFiles)) {
    const target = safeBindingPath(root, path);
    await noSymlinks(root, target);
    if (fingerprint(await readFile(target)) !== expected)
      throw new Error("Stale source fingerprint");
  }
  for (const run of binding.historicalExecutions) {
    const target = safeBindingPath(root, run.artifactPath);
    await noSymlinks(root, target);
    const body = await readFile(target);
    if (fingerprint(body) !== run.artifactDigest)
      throw new Error("Stale execution evidence fingerprint");
    if (binding.framework === "playwright") {
      let report;
      try {
        report = JSON.parse(body.toString("utf8").replace(/^\uFEFF/, ""));
      } catch {
        throw new Error("Invalid historical execution JSON");
      }
      const matches: Record<string, unknown>[] = [];
      const visit = (suites: unknown) => {
        if (!Array.isArray(suites))
          throw new Error("Invalid Playwright historical evidence");
        for (const suite of suites) {
          for (const spec of suite.specs ?? [])
            if (
              spec.id === run.runnerId &&
              spec.title === run.testTitle &&
              typeof spec.file === "string" &&
              (identity.sourceLocation === spec.file ||
                identity.sourceLocation.endsWith(
                  "/" + spec.file.replace(/\\/g, "/"),
                ))
            ) {
              for (const test of spec.tests ?? [])
                if (test.projectName === run.projectName) matches.push(test);
            }
          visit(suite.suites ?? []);
        }
      };
      visit(report.suites);
      if (matches.length !== 1)
        throw new Error("Historical runner evidence missing or ambiguous");
      const attempts = matches[0]!.results as { status?: string }[];
      if (
        !Array.isArray(attempts) ||
        !attempts.length ||
        attempts.some((result) => result.status !== "passed")
      )
        throw new Error("Historical evidence is not an unqualified pass");
    } else {
      // Node historical proof currently needs a reviewed machine-readable mapping, not a title-only inference.
      throw new Error(
        "Node durable historical binding verification not implemented",
      );
    }
  }
  return {
    sourceDigest: identity.sourceDigest,
    evidenceDigest: bindingEvidenceDigest(identity),
  };
}
