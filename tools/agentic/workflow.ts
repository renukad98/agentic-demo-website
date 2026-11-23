import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  inputSchema,
  caseImplementationSchema,
  featureImplementationSchema,
  sourceSchema,
  requirementsSchema,
  scenariosSchema,
  traceabilitySchema,
  executionSchema,
  identitySchema,
  proposalSchema,
  roles,
  stages,
  safeId,
  type WorkflowInput,
  type WorkflowState,
  type Stage,
} from "./contracts/index.js";
import {
  createRun,
  fingerprint,
  objectDigest,
  writeExclusive,
  writeTextExclusive,
  within,
  noSymlinks,
  verifyRepository,
} from "./artifacts.js";
import {
  denyAllApprovals,
  requireApproval,
  type ApprovalProvider,
} from "./approvals.js";
import { loadState, saveState } from "./state.js";
import {
  validateCaseImplementation,
  validateFinalMappings,
} from "./test-implementation.js";
import { assertStoryUnpaused } from "./qa-next.js";
import { recordAudit } from "./audit.js";

const reviewed = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    storyKey: inputSchema.shape.storyKey,
    sourceDigest: inputSchema.shape.sourceDigest,
    accepted: z.literal(true),
    reviewDigest: inputSchema.shape.sourceDigest.optional(),
    evidenceDigests: z
      .record(z.string(), inputSchema.shape.sourceDigest)
      .optional(),
    evidencePaths: z.array(z.string().min(1)).min(1),
  })
  .strict();
const implementation = reviewed.extend({
  implementationFiles: z.array(z.string().min(1)).min(1),
  automatedTestFiles: z.array(z.string().min(1)).min(1),
  browserTestFiles: z.array(z.string().min(1)).min(1),
});
const schemas = {
  source: sourceSchema,
  requirements: requirementsSchema,
  scenarios: scenariosSchema,
  traceability: traceabilitySchema,
  execution: executionSchema,
  implementation,
  featureImplementation: featureImplementationSchema,
  caseImplementation: caseImplementationSchema,
  browserImplementation: caseImplementationSchema,
  review: reviewed,
  automationReview: reviewed,
  inventory: z
    .object({
      schemaVersion: z.literal("1.0.0"),
      storyKey: inputSchema.shape.storyKey,
      identities: z.array(identitySchema).min(1),
    })
    .strict(),
  proposal: proposalSchema,
};
type EvidenceKind = keyof typeof schemas;
const required: Partial<Record<Stage, EvidenceKind[]>> = {
  ANALYZED: ["source", "requirements"],
  DESIGN_REVIEWED: ["scenarios", "review"],
  IMPLEMENTATION_AUTHORIZED: ["requirements", "scenarios"],
  IMPLEMENTED: ["implementation", "inventory"],
  TESTS_IMPLEMENTED: ["caseImplementation"],
  BROWSER_IMPLEMENTED: ["browserImplementation"],
  AUTOMATION_REVIEWED: ["review", "traceability", "inventory"],
  VALIDATED: ["execution"],
  LOCAL_READY: ["execution", "traceability"],
  XRAY_PROPOSED: ["proposal"],
  DELIVERY_PROPOSED: ["proposal"],
};
const owners: Partial<Record<Stage, string>> = {
  ANALYZED: "requirements-analysis-agent",
  DESIGN_REVIEWED: "test-review-agent",
  IMPLEMENTED: "feature-development-agent",
  TESTS_IMPLEMENTED: "feature-development-agent",
  BROWSER_IMPLEMENTED: "playwright-automation-agent",
  AUTOMATION_REVIEWED: "test-review-agent",
  VALIDATED: "test-execution-reporting-agent",
  LOCAL_READY: "qa-orchestrator",
  XRAY_PROPOSED: "xray-test-publisher-agent",
  DELIVERY_PROPOSED: "github-integration-agent",
};
const externalVerified = new Set<Stage>([
  "TESTS_VERIFIED",
  "LINKS_VERIFIED",
  "EXECUTION_VERIFIED",
  "RESULTS_VERIFIED",
  "DELIVERY_VERIFIED",
]);

async function verifySource(input: WorkflowInput) {
  const root = await verifyRepository(input.repository.root);
  if (objectDigest(input.sourceFiles) !== input.sourceDigest)
    throw new Error("Source manifest digest mismatch");
  for (const [file, digest] of Object.entries(input.sourceFiles)) {
    if (/(^|[\\/])(?:\.env(?:\..*)?|\.git|data)(?:[\\/]|$)/i.test(file))
      throw new Error("Secret/live-data paths are not source inputs");
    const path = within(root, file);
    await noSymlinks(root, path);
    if (fingerprint(await readFile(path)) !== digest)
      throw new Error("Stale shared source; new validation required");
  }
}

export class Workflow {
  private constructor(
    readonly path: string,
    readonly input: WorkflowInput,
    private current: WorkflowState,
    private readonly provider: ApprovalProvider,
    private readonly splitImplementation: boolean,
  ) {}
  get state(): WorkflowState {
    return structuredClone(this.current);
  }
  static async start(
    raw: unknown,
    provider = denyAllApprovals,
  ): Promise<Workflow> {
    const input = inputSchema.parse(raw);
    if (input.previousRunId) throw new Error("Use resume for previousRunId");
    await verifySource(input);
    await assertStoryUnpaused(input.repository.root, input.storyKey);
    const run = await createRun(input.repository.root, input.storyKey);
    await writeExclusive(run.path, "manifest.json", {
      schemaVersion: "1.0.0",
      input,
      inputDigest: objectDigest(input),
      remoteWritesEnabled: false,
      implementationWorkflow: "split",
    });
    const state: WorkflowState = {
      schemaVersion: "1.0.0",
      storyKey: input.storyKey,
      runId: run.runId,
      sequence: 0,
      stage: "DISCOVERED",
      status: "ACTIVE",
      sourceDigest: input.sourceDigest,
      updatedAt: new Date().toISOString(),
      evidence: {},
      handoffs: [],
    };
    await saveState(run.path, state);
    return new Workflow(run.path, input, state, provider, true);
  }
  static async resume(
    raw: unknown,
    provider = denyAllApprovals,
  ): Promise<Workflow> {
    const input = inputSchema.parse(raw);
    if (!input.previousRunId) throw new Error("Missing previous run ID");
    safeId.parse(input.previousRunId);
    const root = await verifyRepository(input.repository.root);
    const path = within(
      root,
      `artifacts/qa/${input.storyKey}/${input.previousRunId}`,
    );
    await noSymlinks(root, path);
    const manifest = JSON.parse(
      await readFile(resolve(path, "manifest.json"), "utf8"),
    );
    const original = inputSchema.parse(manifest.input);
    const comparable = { ...input };
    delete comparable.previousRunId;
    if (
      objectDigest(comparable) !== objectDigest(original) ||
      manifest.inputDigest !== objectDigest(original)
    )
      throw new Error("Resume inputs changed; create a new run");
    const state = await loadState(path);
    if (
      state.storyKey !== input.storyKey ||
      state.runId !== input.previousRunId ||
      state.sourceDigest !== input.sourceDigest
    )
      throw new Error("Resume state mismatch");
    if (
      manifest.implementationWorkflow !== undefined &&
      manifest.implementationWorkflow !== "split"
    )
      throw new Error("Unknown implementation workflow");
    const workflow = new Workflow(
      path,
      original,
      state,
      provider,
      manifest.implementationWorkflow === "split",
    );
    await workflow.assertFresh(input.sourceDigest);
    return workflow;
  }
  private async commit(
    next: WorkflowState,
    action: string,
    role: z.infer<typeof roles>,
  ) {
    const before = objectDigest(this.current);
    next.sequence = this.current.sequence + 1;
    next.updatedAt = new Date().toISOString();
    // Audit precedes state: an orphan audit is an attempted transition, never confirmed state.
    await recordAudit(this.path, {
      storyKey: next.storyKey,
      runId: next.runId,
      role,
      action,
      inputDigest: before,
      outputDigest: objectDigest(next),
      outcome: "proposed-state",
    });
    await saveState(this.path, next);
    this.current = next;
  }
  async captureEvidence(text: string) {
    await assertStoryUnpaused(this.input.repository.root, this.input.storyKey);
    const path = `executions/raw-${randomUUID()}.txt`;
    return { path, digest: await writeTextExclusive(this.path, path, text) };
  }
  private async checkReferences(paths: string[], expectedFirstDigest?: string) {
    for (const [index, ref] of paths.entries()) {
      const path = within(this.path, ref);
      await noSymlinks(this.path, path);
      const body = await readFile(path);
      if (
        index === 0 &&
        expectedFirstDigest &&
        fingerprint(body) !== expectedFirstDigest
      )
        throw new Error("Raw evidence digest mismatch");
    }
  }
  async attach(kind: EvidenceKind, raw: unknown) {
    await assertStoryUnpaused(this.input.repository.root, this.input.storyKey);
    if (this.current.status !== "ACTIVE")
      throw new Error("Resume active workflow before attaching evidence");
    const lastStage: Record<EvidenceKind, Stage> = {
      source: "DISCOVERED",
      requirements: "DISCOVERED",
      scenarios: "ANALYZED",
      implementation: "IMPLEMENTATION_AUTHORIZED",
      featureImplementation: "IMPLEMENTATION_AUTHORIZED",
      caseImplementation: "IMPLEMENTED",
      browserImplementation: "TESTS_IMPLEMENTED",
      inventory: this.splitImplementation
        ? "BROWSER_IMPLEMENTED"
        : "IMPLEMENTATION_AUTHORIZED",
      review: this.splitImplementation ? "ANALYZED" : "IMPLEMENTED",
      automationReview: "BROWSER_IMPLEMENTED",
      traceability: this.splitImplementation
        ? "BROWSER_IMPLEMENTED"
        : "IMPLEMENTED",
      execution: "AUTOMATION_REVIEWED",
      proposal: "DELIVERY_PROPOSED",
    };
    if (stages.indexOf(this.current.stage) > stages.indexOf(lastStage[kind]))
      throw new Error("Evidence is frozen after its gate; create a new run");
    const splitEvidence =
      kind === "featureImplementation" ||
      kind === "caseImplementation" ||
      kind === "browserImplementation" ||
      kind === "automationReview";
    if (
      (kind === "implementation" && this.splitImplementation) ||
      (splitEvidence && !this.splitImplementation)
    )
      throw new Error(
        "Evidence does not match the run's implementation workflow",
      );
    if (splitEvidence && this.current.stage !== lastStage[kind])
      throw new Error("Implementation evidence submitted before its handoff");
    const evidence = schemas[kind].parse(raw);
    if (
      "designDigest" in evidence &&
      evidence.designDigest !== this.current.evidence.scenarios?.digest
    )
      throw new Error("Stale reviewed design evidence");
    if (kind === "execution" && this.current.evidence.execution) {
      const previous = executionSchema.parse(await this.evidence("execution"));
      const incoming = executionSchema.parse(evidence);
      if (previous.executionId === incoming.executionId)
        throw new Error("Reruns require a unique execution ID");
    }
    if (evidence.storyKey !== this.input.storyKey)
      throw new Error("Cross-story evidence rejected");
    if (
      "sourceDigest" in evidence &&
      evidence.sourceDigest !== this.input.sourceDigest
    )
      throw new Error("Stale source evidence");
    const path = `evidence/${kind}-${randomUUID()}.json`;
    const digest = await writeExclusive(this.path, path, evidence);
    const next = this.state;
    next.evidence[kind] = { path, digest };
    await this.commit(next, `attach:${kind}`, "qa-orchestrator");
    return path;
  }
  private async evidence(kind: EvidenceKind) {
    const ref = this.current.evidence[kind];
    if (!ref) throw new Error(`Missing ${kind} evidence`);
    const path = within(this.path, ref.path);
    await noSymlinks(this.path, path);
    const body = await readFile(path, "utf8");
    if (fingerprint(body) !== ref.digest)
      throw new Error("Evidence fingerprint changed");
    return JSON.parse(body);
  }
  async assertFresh(sourceDigest: string) {
    if (sourceDigest !== this.current.sourceDigest)
      throw new Error("Stale shared source; new validation required");
    await verifySource(this.input);
    for (const kind of Object.keys(this.current.evidence) as EvidenceKind[]) {
      const proof = await this.evidence(kind);
      if (
        kind === "review" ||
        kind === "automationReview" ||
        kind === "implementation"
      )
        await this.checkReviewReferences(proof);
      if (kind === "featureImplementation") {
        const feature = featureImplementationSchema.parse(proof);
        await this.checkFiles(feature.implementationFiles);
        await this.checkFiles(feature.developerTestFiles);
      }
      if (kind === "caseImplementation" || kind === "browserImplementation")
        await this.checkFiles(caseImplementationSchema.parse(proof).files);
    }
  }
  private async checkReviewReferences(proof: z.infer<typeof reviewed>) {
    if (!this.splitImplementation) {
      await this.checkReferences(proof.evidencePaths);
      return;
    }
    for (const path of proof.evidencePaths) {
      const digest = proof.evidenceDigests?.[path];
      if (!digest) throw new Error("Review evidence digest is required");
      await this.checkReferences([path], digest);
    }
  }
  private async checkFiles(files: Record<string, string>) {
    const root = this.input.repository.root;
    for (const [file, digest] of Object.entries(files)) {
      if (this.input.sourceFiles[file] !== digest)
        throw new Error(
          "Implementation file is absent or stale in the source manifest: " +
            file,
        );
      const path = within(root, file);
      await noSymlinks(root, path);
      if (fingerprint(await readFile(path)) !== digest)
        throw new Error("Stale implementation file: " + file);
    }
  }
  private async coverage() {
    const req = requirementsSchema.parse(await this.evidence("requirements"));
    const cases = scenariosSchema.parse(await this.evidence("scenarios"));
    const mapping = traceabilitySchema.parse(
      await this.evidence("traceability"),
    );
    const inventory = schemas.inventory.parse(await this.evidence("inventory"));
    if (this.splitImplementation) {
      const local = caseImplementationSchema.parse(
        await this.evidence("caseImplementation"),
      );
      const browser = caseImplementationSchema.parse(
        await this.evidence("browserImplementation"),
      );
      validateFinalMappings(
        this.input,
        [...local.mappings, ...browser.mappings],
        inventory.identities,
        mapping.rows,
        cases.scenarios,
        req.requirements,
      );
    }
    const ids = new Set(
      inventory.identities.map(
        (item) => `${item.repository}:${item.runner}:${item.automationId}`,
      ),
    );
    if (ids.size !== inventory.identities.length)
      throw new Error("Duplicate automation inventory identity");
    for (const row of mapping.rows) {
      const requirement = req.requirements.find(
        (r) => r.id === row.requirementId,
      );
      const scenario = cases.scenarios.find((s) => s.id === row.scenarioId);
      if (
        !requirement ||
        !req.acceptanceCriteria.some((a) => a.id === row.acceptanceId) ||
        !requirement.acceptanceIds.includes(row.acceptanceId) ||
        !scenario ||
        !scenario.requirementIds.includes(row.requirementId) ||
        !scenario.acceptanceIds.includes(row.acceptanceId)
      )
        throw new Error("Invalid traceability relation");
      if (
        scenario.kind === "automated" &&
        (!row.automationIdentity || !ids.has(row.automationIdentity))
      )
        throw new Error("Missing automation mapping");
      if (
        scenario.kind === "audit" &&
        (!row.auditEvidence || row.automationIdentity)
      )
        throw new Error("Audit is not an automated execution");
      if (scenario.kind === "audit")
        await this.checkReferences([row.auditEvidence!]);
    }
    for (const id of req.requirements.map((r) => r.id))
      if (!mapping.rows.some((r) => r.requirementId === id))
        throw new Error("Uncovered requirement");
    for (const id of req.acceptanceCriteria.map((a) => a.id))
      if (!mapping.rows.some((r) => r.acceptanceId === id))
        throw new Error("Uncovered acceptance criterion");
    for (const scenario of cases.scenarios)
      if (!mapping.rows.some((r) => r.scenarioId === scenario.id))
        throw new Error("Uncovered scenario");
    return ids;
  }
  async advance(
    target: Stage,
    role: z.infer<typeof roles>,
    currentSourceDigest: string,
    approvalReference = "",
  ) {
    roles.parse(role);
    await assertStoryUnpaused(this.input.repository.root, this.input.storyKey);
    if (this.current.status !== "ACTIVE")
      throw new Error("Workflow is suspended");
    const sequence: readonly Stage[] = this.splitImplementation
      ? stages
      : stages.filter(
          (stage) =>
            stage !== "TESTS_IMPLEMENTED" && stage !== "BROWSER_IMPLEMENTED",
        );
    if (
      !sequence.includes(target) ||
      sequence.indexOf(target) !== sequence.indexOf(this.current.stage) + 1
    )
      throw new Error("Invalid workflow transition");
    await this.assertFresh(currentSourceDigest);
    if (externalVerified.has(target))
      throw new Error(
        "Remote writes and external completion disabled in Phase 5D",
      );
    if (owners[target] && owners[target] !== role)
      throw new Error("Incorrect role handoff");
    const requiredEvidence =
      this.splitImplementation && target === "IMPLEMENTED"
        ? (["featureImplementation"] as const)
        : this.splitImplementation && target === "AUTOMATION_REVIEWED"
          ? (["automationReview", "traceability", "inventory"] as const)
          : (required[target] ?? []);
    for (const kind of requiredEvidence) await this.evidence(kind);
    if (target === "DESIGN_REVIEWED" || target === "AUTOMATION_REVIEWED") {
      const kind =
        this.splitImplementation && target === "AUTOMATION_REVIEWED"
          ? "automationReview"
          : "review";
      const review = reviewed.parse(await this.evidence(kind));
      if (this.splitImplementation) {
        const expected =
          target === "DESIGN_REVIEWED"
            ? this.current.evidence.scenarios?.digest
            : objectDigest(
                [
                  "caseImplementation",
                  "browserImplementation",
                  "inventory",
                  "traceability",
                ].map((kind) => this.current.evidence[kind]?.digest),
              );
        if (review.reviewDigest !== expected)
          throw new Error("Review must bind the exact evidence revision");
      }
    }
    if (target === "TESTS_IMPLEMENTED" || target === "BROWSER_IMPLEMENTED") {
      const browser = target === "BROWSER_IMPLEMENTED";
      const proof = caseImplementationSchema.parse(
        await this.evidence(
          browser ? "browserImplementation" : "caseImplementation",
        ),
      );
      const cases = scenariosSchema.parse(await this.evidence("scenarios"));
      const handoff = browser
        ? caseImplementationSchema.parse(
            await this.evidence("caseImplementation"),
          ).browserCases
        : undefined;
      validateCaseImplementation(cases.scenarios, proof, handoff);
    }
    if (target === "IMPLEMENTED" && !this.splitImplementation) {
      const proof = implementation.parse(await this.evidence("implementation"));
      await this.checkReferences(proof.evidencePaths);
      for (const file of [
        ...proof.implementationFiles,
        ...proof.automatedTestFiles,
        ...proof.browserTestFiles,
      ]) {
        const path = within(this.input.repository.root, file);
        await noSymlinks(this.input.repository.root, path);
        await readFile(path);
      }
    }
    if (target === "ANALYZED") {
      const req = requirementsSchema.parse(await this.evidence("requirements"));
      if (req.unresolvedQuestions.length)
        throw new Error("Unresolved requirements");
    }
    if (
      target === "DESIGN_REVIEWED" &&
      scenariosSchema.parse(await this.evidence("scenarios")).review !==
        "accepted"
    )
      throw new Error("Design changes requested");
    if (target === "IMPLEMENTATION_AUTHORIZED") {
      const payload = {
        requirements: await this.evidence("requirements"),
        scenarios: await this.evidence("scenarios"),
      };
      const approval = await requireApproval(this.provider, approvalReference, {
        schemaVersion: "1.0.0",
        operation: "feature.implement",
        target: this.input.storyKey,
        payloadDigest: objectDigest(payload),
        evidenceDigest: this.input.sourceDigest,
        scope: [this.input.approvedScopeReference],
      });
      await writeExclusive(
        this.path,
        `approvals/${approval.id}-${randomUUID()}.json`,
        approval,
      );
    }
    if (["AUTOMATION_REVIEWED", "VALIDATED", "LOCAL_READY"].includes(target)) {
      const ids = await this.coverage();
      if (target !== "AUTOMATION_REVIEWED") {
        const execution = executionSchema.parse(
          await this.evidence("execution"),
        );
        if (this.splitImplementation) {
          const browser = caseImplementationSchema.parse(
            await this.evidence("browserImplementation"),
          );
          if (
            (target === "LOCAL_READY" && !browser.mappings.length) ||
            browser.mappings.some(
              ({ automationIdentity }) =>
                !execution.results.some(
                  (result) =>
                    result.identity === automationIdentity &&
                    result.runner === "playwright" &&
                    result.outcome === "passed",
                ),
            )
          )
            throw new Error(
              "Persisted and executed Playwright coverage is required for local readiness",
            );
        }
        for (const result of execution.results)
          await this.checkReferences(result.evidence, result.artifactDigest);
        for (const gate of execution.gates)
          await this.checkReferences([gate.evidence]);
        for (const gate of this.input.requiredQualityGates)
          if (!execution.gates.some((g) => g.name === gate && g.exitCode === 0))
            throw new Error(`Quality gate not passed: ${gate}`);
        for (const id of ids)
          if (!execution.results.some((r) => r.identity === id))
            throw new Error("Unexecuted automation identity");
        if (
          execution.results.some(
            (r) => !ids.has(r.identity) || r.outcome !== "passed",
          )
        )
          throw new Error("Failed, unknown, skipped, or unmapped results");
      }
    }
    const next = this.state;
    next.stage = target;
    next.handoffs.push({
      role,
      stage: target,
      at: new Date().toISOString(),
      evidencePaths: Object.values(next.evidence).map((r) => r.path),
    });
    await this.commit(next, `advance:${target}`, role);
  }
  async suspend(
    status: "BLOCKED" | "FAILED" | "AWAITING_APPROVAL" | "UNCERTAIN",
    reason: string,
  ) {
    await assertStoryUnpaused(this.input.repository.root, this.input.storyKey);
    if (!reason.trim()) throw new Error("Suspension needs a reason");
    const next = this.state;
    next.status = status;
    next.reason = reason;
    await this.commit(next, "suspend", "qa-orchestrator");
  }
  async reactivate(sourceDigest: string) {
    await assertStoryUnpaused(this.input.repository.root, this.input.storyKey);
    if (this.current.status === "UNCERTAIN")
      throw new Error(
        "Uncertain external operations require reconciliation; no automatic resume",
      );
    await this.assertFresh(sourceDigest);
    const next = this.state;
    next.status = "ACTIVE";
    delete next.reason;
    await this.commit(next, "reactivate", "qa-orchestrator");
  }
  report() {
    return {
      input: this.input,
      state: this.state,
      remoteWritesEnabled: false,
      executionModel:
        "sequential reusable skills; coordinator does not implement features or invoke agents",
      localReady:
        stages.indexOf(this.current.stage) >= stages.indexOf("LOCAL_READY"),
    };
  }
}
