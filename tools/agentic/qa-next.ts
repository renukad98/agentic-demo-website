import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fingerprint, noSymlinks, objectDigest, within } from "./artifacts.js";
import { digest, storyKey } from "./contracts/index.js";

const featureProgress = z.object({
  storyKey,
  stage: z.string(),
  paused: z.boolean().optional(),
  completedStages: z.array(z.string()),
  pendingStages: z.array(z.string()),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
type FeatureProgress = z.infer<typeof featureProgress>;
const evidenceRef = z.object({ path: z.string(), digest }).strict();
const routingProof = z
  .object({
    storyKey,
    kind: z.enum(["feature-development", "agent-06", "legacy-equivalent"]),
    design: evidenceRef,
    designReview: evidenceRef,
    coverageReview: evidenceRef,
    caseMappings: evidenceRef,
    sourceFiles: z
      .record(z.string(), digest)
      .refine((files) => Object.keys(files).length > 0),
  })
  .strict();

const commands: Record<string, string> = {
  story: "qa story",
  requirements: "qa requirements",
  designed: "qa test-design",
  reviewed: "qa test-review",
  "branch-ready": "qa branch",
  implemented: "qa implement",
  automated: "qa e2e",
  executed: "qa run",
  published: "qa xray",
  "in-review": "qa pr",
  done: "qa close",
};
const caseStage = "tests-implemented";
const downstream = new Set(["automated", "executed", "in-review", "done"]);

export function isStoryPaused(
  feature: Pick<FeatureProgress, "storyKey" | "stage" | "paused">,
) {
  return (
    feature.paused === true ||
    feature.stage === "paused" ||
    ["KAN-29", "KAN-30"].includes(feature.storyKey)
  );
}

export async function assertStoryUnpaused(root: string, key: string) {
  if (isStoryPaused({ storyKey: key, stage: "" }))
    throw new Error(key + " is paused");
  const path = within(root, "qa/" + key + "/feature.json");
  await noSymlinks(root, path);
  const record = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (record === undefined) return;
  const feature = z
    .object({ storyKey, stage: z.string(), paused: z.boolean().optional() })
    .parse(JSON.parse(record));
  if (feature.storyKey !== key)
    throw new Error("Feature record Story mismatch");
  if (isStoryPaused(feature)) throw new Error(key + " is paused");
}

async function readLocal(root: string, path: string) {
  const target = within(root, path);
  await noSymlinks(root, target);
  return readFile(target);
}

export function hasAcceptedDesignReview(review: string, designDigest: string) {
  return (
    /^- (?:Decision|Review decision): accepted(?: for design)?(?:[.\r]|$)/im.test(
      review,
    ) && review.includes("testDesign " + designDigest.slice(7))
  );
}

async function verifyImplementation(root: string, feature: FeatureProgress) {
  const refs = feature.evidence;
  if (typeof refs?.testImplementation !== "string") return false;
  const prefix = "artifacts/qa/" + feature.storyKey + "/";
  const inStory = (path: string) =>
    path.startsWith(prefix) &&
    !path.includes("\\") &&
    !path.split("/").includes("..");
  try {
    if (!inStory(refs.testImplementation)) return false;
    const proof = routingProof.parse(
      JSON.parse(
        (await readLocal(root, refs.testImplementation)).toString("utf8"),
      ),
    );
    if (
      proof.storyKey !== feature.storyKey ||
      proof.design.path !== refs.testDesign ||
      proof.designReview.path !== refs.testReview
    )
      return false;
    const readReviewed = async (ref: z.infer<typeof evidenceRef>) => {
      if (!inStory(ref.path))
        throw new Error("Review evidence must belong to the Story");
      const body = await readLocal(root, ref.path);
      if (fingerprint(body) !== ref.digest)
        throw new Error("Stale review evidence");
      return body.toString("utf8");
    };
    const { coverageReview: reviewRef, ...reviewedRevision } = proof;
    const [, designReview, coverageReview] = await Promise.all([
      readReviewed(proof.design),
      readReviewed(proof.designReview),
      readReviewed(reviewRef),
      readReviewed(proof.caseMappings),
    ]);
    if (
      !hasAcceptedDesignReview(designReview, proof.design.digest) ||
      !/^- Decision: accepted for case implementation\.\r?$/im.test(
        coverageReview,
      ) ||
      !coverageReview
        .split(/\r?\n/)
        .includes(`- Coverage revision: ${objectDigest(reviewedRevision)}`)
    )
      return false;
    for (const [path, expected] of Object.entries(proof.sourceFiles)) {
      if (
        /^(?:artifacts|public\/data)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\..*)?|\.git|data)(?:[\\/]|$)/i.test(
          path,
        ) ||
        fingerprint(await readLocal(root, path)) !== expected
      )
        return false;
    }
    return true;
  } catch {
    // Missing, invalid or unreadable optional proof leaves the QA step pending.
    return false;
  }
}

export async function resolveQaNext(root: string, record: unknown) {
  const feature = featureProgress.parse(record);
  if (
    isStoryPaused(feature) ||
    feature.stage === "done" ||
    feature.completedStages.includes("done")
  )
    return { pendingStages: feature.pendingStages, nextCommand: null };
  const implementationComplete =
    feature.completedStages.includes("implemented");
  const pendingStages = feature.pendingStages.filter(
    (stage) =>
      stage !== caseStage &&
      !(implementationComplete && stage === "implemented"),
  );
  const pendingImplementation = implementationComplete
    ? !(await verifyImplementation(root, feature))
    : feature.pendingStages.includes(caseStage);
  if (pendingImplementation && !pendingStages.includes("implemented")) {
    const index = pendingStages.findIndex((stage) => downstream.has(stage));
    pendingStages.splice(
      index < 0 ? pendingStages.length : index,
      0,
      "implemented",
    );
  }
  return {
    pendingStages,
    nextCommand: commands[pendingStages[0] ?? ""] ?? null,
  };
}

const acceptedAutomation = /^- Decision: accepted for automation\.\r?$/m;

async function verifyLegacyAutomationReview(
  root: string,
  feature: FeatureProgress,
) {
  const refs = feature.evidence;
  const prefix = "artifacts/qa/" + feature.storyKey + "/";
  const inStory = (path: string) => path.startsWith(prefix);
  const safePath = (path: string) =>
    !path.includes("\\") &&
    !path.split("/").some((part) => part.startsWith("."));

  if (
    typeof refs?.automationReview !== "string" ||
    !inStory(refs.automationReview) ||
    !safePath(refs.automationReview)
  )
    return false;

  const report = (await readLocal(root, refs.automationReview)).toString(
    "utf8",
  );
  if (!acceptedAutomation.test(report)) return false;
  const section =
    report.split(/^## Reviewed revisions[ \t]*\r?$/m)[1]?.split(/^## /m)[0] ??
    "";
  const entries = [
    ...section.matchAll(/^- (\S+) (sha256:[a-f0-9]{64})[ \t]*\r?$/gm),
  ];
  const revisions = new Map(entries.map((entry) => [entry[1]!, entry[2]!]));
  if (revisions.size !== entries.length) return false;

  let mapping = refs.caseMappings;
  let sources: string[] = [];
  if (typeof refs.testImplementation === "string") {
    if (!inStory(refs.testImplementation) || !safePath(refs.testImplementation))
      return false;
    const implementation = routingProof.parse(
      JSON.parse(
        (await readLocal(root, refs.testImplementation)).toString("utf8"),
      ),
    );
    if (implementation.storyKey !== feature.storyKey) return false;
    mapping = implementation.caseMappings.path;
    sources = Object.keys(implementation.sourceFiles);
  }
  if (
    typeof mapping !== "string" ||
    !inStory(mapping) ||
    !revisions.has(mapping)
  )
    return false;

  const paths = [...revisions.keys()];
  const browserPath = /^tests\/e2e\/.+\.spec\.[cm]?[jt]sx?$/;
  if (
    typeof refs.browserTest === "string"
      ? !browserPath.test(refs.browserTest) || !revisions.has(refs.browserTest)
      : !paths.some((path) => browserPath.test(path))
  )
    return false;
  if (
    !paths.some((path) => /^(?:src|public)\//.test(path)) ||
    sources.some((path) => !revisions.has(path))
  )
    return false;
  for (const [path, expected] of revisions) {
    if (
      !safePath(path) ||
      (!inStory(path) &&
        path !== "playwright.config.ts" &&
        !/^(?:src|public(?!\/data(?:\/|$))|tests)\//.test(path)) ||
      fingerprint(await readLocal(root, path)) !== expected
    )
      return false;
  }
  return true;
}

const handoffContext = z.object({
  mode: z.enum(["one-step", "end-to-end", "read-only"]).default("one-step"),
  runScope: z.object({
    storyKey,
    runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
  }).optional(),
  status: z
    .enum(["ready", "blocked", "failed", "declined", "uncertain"])
    .default("ready"),
  reason: z.string().trim().min(1).optional(),
  blocker: z.object({
    dependency: z.string().trim().min(1),
    review: z.object({ agent: z.string(), purpose: z.string().trim().min(1) }).optional(),
    remaining: z.array(z.string().trim().min(1)).default([]),
  }).optional(),
  completed: z
    .object({
      command: z.string(),
      artifacts: z.array(evidenceRef).min(1),
    })
    .optional(),
});

const pipelineSchema = z.object({
  skills: z.record(z.string(), z.string()),
  commands: z.record(z.string(), z.object({ skill: z.string(), purpose: z.string().min(1) })),
  handoffs: z.object({
    safeAnalysis: z.array(
      z.enum([
        "qa requirements",
        "qa test-design",
        "qa test-review",
      ]),
    ),
    approvalGates: z.record(z.string(), z.string()),
  }),
});

export async function recommendQaHandoff(
  root: string,
  record: unknown,
  input: unknown = {},
) {
  const feature = featureProgress.parse(record);
  const context = handoffContext.parse(input);
  const pipeline = pipelineSchema.parse(
    JSON.parse((await readLocal(root, "qa/pipeline.json")).toString()),
  );
  const role = (command: string) => {
    const entry = pipeline.commands[command];
    if (!entry || !pipeline.skills[entry.skill])
      throw new Error(`No mapped skill for ${command}`);
    return { command, agent: entry.skill, skillPath: pipeline.skills[entry.skill], purpose: entry.purpose };
  };
  const confirmationFor = (command: string) =>
    command.endsWith(" " + feature.storyKey)
      ? command
      : "Confirm `" + command + "` for " + feature.storyKey + " only.";
  const prefix = `artifacts/qa/${feature.storyKey}/`;
  const verifiedArtifact = async ({
    path,
    digest: expected,
  }: z.infer<typeof evidenceRef>) => {
    if (
      !path.startsWith(prefix) ||
      path.includes("\\") ||
      path.split("/").includes("..")
    )
      return null;
    const contents = await readLocal(root, path);
    return fingerprint(contents) === expected ? contents : null;
  };
  const completed = context.completed && {
    ...role(context.completed.command.replace(/^(qa xray-status) .+$/, "$1")),
    command: context.completed.command,
    artifacts: context.completed.artifacts,
  };
  const stop = (
    reason: string,
    next: (Omit<ReturnType<typeof role>, "command"> & { command: string | null }) | null = null,
    confirmation: string | null = next?.command ? confirmationFor(next.command) : null,
    blockers: string[] = [reason],
  ) => ({
    completed,
    next,
    reason,
    confirmation,
    blockers,
    approvalRequirement: confirmation ? "Confirm this recovery stage separately. Any protected operation requires its own exact preview and approval." : null,
    approvalStatus: "not-applicable",
    continuationStatus: "blocked",
    disposition: "stop",
  });
  if (
    completed &&
    !(
      await Promise.all(completed.artifacts.map(verifiedArtifact)).catch(() => [
        false,
      ])
    ).every(Boolean)
  )
    return {
      ...stop("Completed-stage artifacts are missing or stale."),
      completed: undefined,
    };
  if (isStoryPaused(feature)) return stop("Story is paused.");
  if (feature.stage === "done" || feature.completedStages.includes("done"))
    return stop("Story is Done.", null, null, []);
  if (context.status !== "ready") {
    const reason = context.reason ?? `The previous stage is ${context.status}.`;
    const dependency = context.blocker?.dependency ??
      "The previous stage needs a verified resolution before dependent work can resume.";
    const blockers = [dependency, ...(context.blocker?.remaining ?? [])];
    const review = context.status === "blocked" ? context.blocker?.review : undefined;
    if (review && Object.hasOwn(pipeline.skills, review.agent))
      return stop(reason, { ...review, command: null, skillPath: pipeline.skills[review.agent]! },
        "Confirm " + review.agent + " read-only blocker review for " + feature.storyKey + ".", blockers);
    return stop(reason, null, null, blockers);
  }

  const route = await resolveQaNext(root, feature);
  let command = route.nextCommand;
  if (!command)
    return stop(
      route.pendingStages.length
        ? "The pending stage has no command mapping."
        : "No stages are pending.",
      null, null, route.pendingStages.length ? ["A registered command for the pending stage is missing."] : [],
    );
  let reviewAutomation = false;
  let reason = `The next pending stage is ${route.pendingStages[0]}.`;
  if (
    command === "qa implement" &&
    feature.completedStages.includes("implemented")
  )
    reason =
      "Implementation evidence is missing or stale. Reconcile the reviewed case mappings before downstream work.";
  if (
    ["qa run", "qa pr", "qa close"].includes(command) &&
    feature.completedStages.includes("automated")
  ) {
    const current = feature.evidence?.automationReviewProof;
    const review = evidenceRef.safeParse(current);
    const content = review.success
      ? await verifiedArtifact(review.data).catch(() => null)
      : null;
    const accepted = current === undefined
      ? await verifyLegacyAutomationReview(root, feature).catch(() => false)
      : Boolean(content && acceptedAutomation.test(content.toString()));
    if (!accepted) {
      command = "qa test-review";
      reviewAutomation = true;
      reason =
        "Execution and delivery require a current post-implementation automation review.";
    }
  }
  const next = role(command);
  if (reviewAutomation) next.purpose = "Review implemented browser cases and confirm current automation evidence.";
  const confirmation = reviewAutomation
    ? "Confirm post-implementation test review for " + feature.storyKey + " via qa test-review."
    : confirmationFor(next.command);
  const gate = pipeline.handoffs.approvalGates[command];
  if (gate)
    return {
      completed,
      next,
      reason,
      confirmation,
      blockers: [],
      approvalRequirement: gate,
      approvalStatus: "required",
      gate,
      continuationStatus: "approval-required",
      disposition: "stop",
    };
  const safe = pipeline.handoffs.safeAnalysis.some(
    (candidate) => candidate === command,
  );
  const analysisPrerequisites: Partial<Record<string, string>> = {
    "qa requirements": "story",
    "qa test-design": "requirements",
    "qa test-review": "designed",
  };
  const prerequisite = reviewAutomation ? "automated" : analysisPrerequisites[command];
  if (safe && prerequisite && !feature.completedStages.includes(prerequisite))
    return stop(`The ${prerequisite} stage must be verified first.`, next);
  const scope = context.runScope;
  const scopedRun = scope?.storyKey === feature.storyKey &&
    (!completed || completed.artifacts.every(({ path }) => path.startsWith(`${prefix}${scope.runId}/`)));
  const autoContinue = safe && context.mode === "end-to-end" && scopedRun;
  if (safe && context.mode === "end-to-end" && !scopedRun)
    reason += " Automatic analysis requires explicit scope for this Story and run.";
  return {
    completed,
    next,
    reason,
    confirmation: autoContinue ? null : confirmation,
    blockers: [],
    approvalRequirement: safe ? null : "Confirm the named stage and check its scope before any protected operation.",
    approvalStatus: safe ? "not-required-for-analysis" : "requires-scope-check",
    continuationStatus: autoContinue ? "authorized-for-run" : "confirmation-required",
    disposition: autoContinue ? "continue-analysis" : "stop",
  };
}

async function main() {
  const root = process.cwd();
  const [mode, target, ...extra] = process.argv.slice(2);
  if ((mode && mode !== "--handoff") || extra.length)
    throw new Error("Use qa-next.ts [--handoff [STORY-KEY]]");
  const selected = target
    ? { storyKey: storyKey.parse(target), featureFile: "qa/" + target + "/feature.json" }
    : z.object({ storyKey, featureFile: z.string() }).parse(
        JSON.parse((await readLocal(root, "qa/current.json")).toString("utf8")),
      );
  if (selected.featureFile !== "qa/" + selected.storyKey + "/feature.json")
    throw new Error("Invalid Story feature record path");
  const record: unknown = JSON.parse(
    (await readLocal(root, selected.featureFile)).toString("utf8"),
  );
  const feature = featureProgress.parse(record);
  if (feature.storyKey !== selected.storyKey)
    throw new Error("Feature record Story mismatch");
  let result: unknown;
  if (mode === "--handoff") {
    process.stdin.setEncoding("utf8");
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    result = await recommendQaHandoff(
      root,
      record,
      input.trim() ? JSON.parse(input) : {},
    );
  } else {
    result = await resolveQaNext(root, feature);
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}
