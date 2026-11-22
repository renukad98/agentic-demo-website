import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  canonical,
  fingerprint,
  noSymlinks,
  objectDigest,
  within,
  writeExclusive,
} from "./artifacts.js";
import { parseReviewedCases } from "./chat-xray.js";
import { storyKey as key } from "./contracts/index.js";

const id = z.string().regex(/^[1-9]\d*$/);
const caseId = z.string().regex(/^[A-Z][A-Z0-9-]*-TC-\d+$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const transition = z.object({
  id,
  to: z.string(),
  requiredFields: z.array(z.string()),
});
const issue = z.object({
  key,
  id,
  issueType: z.enum(["Story", "Test", "Test Plan", "Test Execution"]),
  status: z.string().min(1),
});
const relatedIssue = issue.extend({
  storyKey: key,
  linkId: id,
  linkType: z.enum(["Test", "Relates"]),
  transitions: z.array(transition),
});
const evidence = z.object({
  storyKey: key,
  caseId,
  testKey: key,
  outcome: z.enum(["passed", "failed", "skipped", "not-run"]),
});
const contextSchema = z.object({
  cloudId: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.href === url.origin + "/";
  }),
  story: issue,
  plan: relatedIssue,
  tests: z.array(relatedIssue),
  caseEvidence: z
    .array(z.object({ caseId, path: z.string(), sha256: digest }))
    .default([]),
  execution: issue
    .extend({
      planKey: key,
      runs: z.array(evidence),
    })
    .optional(),
  planMembers: z.array(key).default([]),
});
const featureSchema = z.object({
  storyKey: key,
  stage: z.string(),
  paused: z.boolean().optional(),
  completedStages: z.array(z.string()),
  testPlanKey: key,
  testExecutionKey: key.optional(),
  evidence: z.object({ testDesign: z.string(), testReview: z.string() }),
  verifiedRecords: z
    .object({
      postMergeExecution: z.object({ testExecutionKey: key }).optional(),
    })
    .optional(),
});
const receiptIssue = issue.pick({
  key: true,
  id: true,
  issueType: true,
  status: true,
});
const paused = (value: string) => ["KAN-29", "KAN-30"].includes(value);

async function read(root: string, path: string) {
  const file = within(root, path);
  await noSymlinks(root, file);
  return readFile(file);
}
async function readEvidence(root: string, story: string, path: string) {
  if (
    !path.startsWith("artifacts/qa/" + story + "/") ||
    path.split(/[\\/]/).some((part) => part === "..") ||
    path.includes("\\")
  )
    throw new Error(
      "Evidence must be under the selected Story's artifact directory",
    );
  return read(root, path);
}

export async function prepareXrayLifecycle(
  root: string,
  command: string,
  input: unknown,
) {
  const match =
    /^qa xray-status (start|finish)(?: ([A-Z][A-Z0-9]*-\d+))?$/i.exec(command);
  if (!match) throw new Error("Use qa xray-status start|finish [STORY-KEY]");
  const target = match[1]!.toLowerCase() === "start" ? "In Progress" : "Done";
  const pointer = match[2]
    ? {
        storyKey: key.parse(match[2].toUpperCase()),
        featureFile: "qa/" + match[2].toUpperCase() + "/feature.json",
      }
    : z
        .object({ storyKey: key, featureFile: z.string() })
        .parse(JSON.parse((await read(root, "qa/current.json")).toString()));
  const story = pointer.storyKey;
  if (paused(story)) throw new Error(story + " is paused");
  if (pointer.featureFile !== "qa/" + story + "/feature.json")
    throw new Error("Invalid feature path");
  const feature = featureSchema.parse(
    JSON.parse((await read(root, pointer.featureFile)).toString()),
  );
  if (
    feature.storyKey !== story ||
    feature.paused ||
    feature.stage === "paused"
  )
    throw new Error("Story is paused or does not match its QA record");
  if (
    !["reviewed", "published"].every((stage) =>
      feature.completedStages.includes(stage),
    )
  )
    throw new Error(
      "Accepted design review and verified publication are required",
    );

  const context = contextSchema.parse(input);
  const project = story.split("-")[0]!;
  const sameProject = (value: string) =>
    value.startsWith(project + "-") && !paused(value);
  if (context.story.key !== story || context.story.issueType !== "Story")
    throw new Error("Verified Jira Story identity is required");
  if (
    context.plan.key !== feature.testPlanKey ||
    context.plan.issueType !== "Test Plan" ||
    context.plan.storyKey !== story ||
    context.plan.linkType !== "Relates" ||
    !sameProject(context.plan.key)
  )
    throw new Error("Verified Test Plan relationship is required");

  const [design, review, mapping] = await Promise.all([
    readEvidence(root, story, feature.evidence.testDesign),
    readEvidence(root, story, feature.evidence.testReview),
    readEvidence(root, story, "artifacts/qa/" + story + "/xray-test-keys.json"),
  ]);
  const designHash = fingerprint(design);
  if (
    !/^- (?:Decision|Review decision): accepted(?: for design)?(?:[.\r]|$)/im.test(
      review.toString(),
    ) ||
    !review.toString().includes("testDesign " + designHash.slice(7))
  )
    throw new Error("An accepted review for the exact design is required");
  const reviewed = parseReviewedCases(design.toString(), story);
  const keys = z.record(caseId, key).parse(JSON.parse(mapping.toString()));
  if (
    reviewed.some(
      ({ caseId }) => !caseId.startsWith(story + "-TC-") || !keys[caseId],
    ) ||
    Object.keys(keys).length !== reviewed.length ||
    new Set(Object.values(keys)).size !== reviewed.length
  )
    throw new Error("The complete reviewed case-to-Test mapping is required");
  if (
    context.tests.length !== reviewed.length ||
    new Set(context.tests.map((test) => test.key)).size !== reviewed.length ||
    new Set([
      context.story.id,
      context.plan.id,
      ...context.tests.map((test) => test.id),
    ]).size !==
      reviewed.length + 2
  )
    throw new Error("Expected one distinct verified Test per reviewed case");

  const localEvidence = new Map<string, { outcome: string; sha256: string }>();
  for (const reference of context.caseEvidence) {
    if (!keys[reference.caseId] || localEvidence.has(reference.caseId))
      throw new Error("Unexpected or duplicate local case evidence");
    const contents = await readEvidence(root, story, reference.path);
    if (fingerprint(contents) !== reference.sha256)
      throw new Error("Local execution evidence changed");
    const result = evidence.parse(JSON.parse(contents.toString()));
    if (
      result.storyKey !== story ||
      result.caseId !== reference.caseId ||
      result.testKey !== keys[result.caseId]
    )
      throw new Error("Local execution evidence does not match the case");
    localEvidence.set(result.caseId, {
      outcome: result.outcome,
      sha256: reference.sha256,
    });
  }
  const execution = context.execution;
  const executionKey =
    feature.verifiedRecords?.postMergeExecution?.testExecutionKey ??
    feature.testExecutionKey;
  if (
    execution &&
    (execution.issueType !== "Test Execution" ||
      execution.planKey !== context.plan.key ||
      !sameProject(execution.key) ||
      execution.key !== executionKey ||
      new Set(execution.runs.map((run) => run.caseId)).size !==
        execution.runs.length ||
      execution.runs.some(
        (run) => run.storyKey !== story || keys[run.caseId] !== run.testKey,
      ))
  )
    throw new Error(
      "Execution readback does not match the recorded Story, plan, or cases",
    );

  const decisions = reviewed.map(({ caseId }) => {
    const test = context.tests.find(
      (candidate) => candidate.key === keys[caseId],
    );
    if (
      !test ||
      test.issueType !== "Test" ||
      test.storyKey !== story ||
      test.linkType !== "Test" ||
      !sameProject(test.key)
    )
      throw new Error("Verified Story coverage is required for " + caseId);
    const run = execution?.runs.find(
      (candidate) => candidate.caseId === caseId,
    );
    const local = localEvidence.get(caseId);
    const passed = run ? run.outcome === "passed" : local?.outcome === "passed";
    const ready =
      target === "In Progress" ||
      (feature.completedStages.includes("executed") && passed);
    return {
      caseId,
      testKey: test.key,
      status: test.status,
      passed: Boolean(passed),
      ...proposal(
        test,
        target,
        Boolean(ready),
        "Passing case evidence is required",
      ),
    };
  });
  const members = [...context.planMembers].sort();
  const required = Object.values(keys).sort();
  const planReady =
    Boolean(execution) &&
    canonical(members) === canonical(required) &&
    decisions.every(
      (decision) => decision.status === "Done" && decision.passed,
    );
  const plan = {
    testPlanKey: context.plan.key,
    status: context.plan.status,
    ...proposal(
      context.plan,
      target,
      target === "In Progress" || planReady,
      "Verified plan membership, execution and passing Done Tests are required",
    ),
  };
  const revision = objectDigest({
    feature,
    designHash,
    review: fingerprint(review),
    keys,
    context,
  });
  return {
    cloudId: context.cloudId,
    storyKey: story,
    projectKey: project,
    target,
    revision,
    tests: decisions,
    plan,
  };
}

function proposal(
  item: z.infer<typeof relatedIssue>,
  target: "In Progress" | "Done",
  ready: boolean,
  reason: string,
) {
  if (
    item.status === target ||
    (target === "In Progress" && item.status === "Done")
  )
    return { state: "already-at-or-beyond-target" } as const;
  if (item.status !== (target === "In Progress" ? "To Do" : "In Progress"))
    return {
      state: "blocked",
      reason: "The previous lifecycle status is required",
    } as const;
  if (!ready) return { state: "blocked", reason } as const;
  const matches = item.transitions.filter(
    (candidate) => candidate.to === target,
  );
  if (matches.length !== 1 || matches[0]!.requiredFields.length)
    return {
      state: "blocked",
      reason: "Expected one available transition without required fields",
    } as const;
  return {
    state: "ready",
    issueId: item.id,
    issueType: item.issueType,
    from: item.status,
    to: target,
    issueIdOrKey: item.key,
    transitionId: matches[0]!.id,
  } as const;
}

export async function previewXrayLifecycle(
  root: string,
  command: string,
  input: unknown,
  issueKey: string,
) {
  const snapshot = await prepareXrayLifecycle(root, command, input);
  const candidates = [...snapshot.tests, snapshot.plan];
  const operation = candidates.find(
    (candidate) =>
      candidate.state === "ready" && candidate.issueIdOrKey === issueKey,
  );
  if (!operation || operation.state !== "ready")
    throw new Error("Selected issue has no eligible transition");
  return {
    storyKey: snapshot.storyKey,
    projectKey: snapshot.projectKey,
    revision: snapshot.revision,
    issueId: operation.issueId,
    issueType: operation.issueType,
    from: operation.from,
    to: operation.to,
    arguments: {
      cloudId: snapshot.cloudId,
      issueIdOrKey: operation.issueIdOrKey,
      transitionId: operation.transitionId,
    },
  };
}

export async function checkXrayLifecycle(
  root: string,
  command: string,
  input: unknown,
  issueKey: string,
  approved: unknown,
  reply: string,
) {
  const fresh = await previewXrayLifecycle(root, command, input, issueKey);
  if (
    reply.trim().toUpperCase() !== "OK" ||
    canonical(fresh) !== canonical(approved)
  )
    throw new Error("The latest exact transition preview requires OK");
  return fresh;
}

export async function recordXrayLifecycle(
  root: string,
  command: string,
  input: unknown,
  issueKey: string,
  approved: unknown,
  reply: string,
  readback: unknown,
) {
  const operation = await checkXrayLifecycle(
    root,
    command,
    input,
    issueKey,
    approved,
    reply,
  );
  const actual = receiptIssue.parse(readback);
  if (
    actual.key !== operation.arguments.issueIdOrKey ||
    actual.id !== operation.issueId ||
    actual.issueType !== operation.issueType ||
    actual.status !== operation.to
  )
    throw new Error("Jira transition readback does not match approval");
  const receipt = { operation, readback: actual };
  const path =
    "artifacts/qa/" +
    operation.storyKey +
    "/lifecycle/" +
    objectDigest(receipt).slice(7) +
    ".json";
  try {
    await writeExclusive(root, path, receipt);
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code !== "EEXIST" ||
      canonical(JSON.parse((await read(root, path)).toString())) !==
        canonical(receipt)
    )
      throw error;
  }
  return { path, status: actual.status };
}

async function main() {
  const [action, command, issueKey] = process.argv.slice(2);
  if (
    !command ||
    !["readiness", "preview", "check", "record"].includes(action ?? "") ||
    (action !== "readiness" && !issueKey)
  )
    throw new Error(
      'Use readiness|preview|check|record "qa xray-status start|finish [STORY-KEY]" [ISSUE-KEY]',
    );
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  const packet = z
    .object({
      context: z.unknown(),
      preview: z.unknown().optional(),
      reply: z.string().default(""),
      readback: z.unknown().optional(),
    })
    .parse(JSON.parse(source));
  const root = process.cwd();
  const result =
    action === "readiness"
      ? await prepareXrayLifecycle(root, command, packet.context)
      : action === "preview"
        ? await previewXrayLifecycle(root, command, packet.context, issueKey!)
        : action === "check"
          ? await checkXrayLifecycle(
              root,
              command,
              packet.context,
              issueKey!,
              packet.preview,
              packet.reply,
            )
          : await recordXrayLifecycle(
              root,
              command,
              packet.context,
              issueKey!,
              packet.preview,
              packet.reply,
              packet.readback,
            );
  console.log(JSON.stringify(result, null, 2));
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Xray lifecycle failed",
    );
    process.exitCode = 1;
  });
