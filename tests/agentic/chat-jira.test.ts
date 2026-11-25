import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fingerprint, objectDigest } from "../../tools/agentic/artifacts.js";
import { test, type TestContext } from "node:test";
import {
  approvedJira,
  prepareJira,
  recordJira,
} from "../../tools/agentic/chat-jira.js";

const cloudId = "https://jira.example.test";
const story = {
  key: "KAN-51",
  id: "10051",
  projectKey: "KAN",
  issueType: "Story" as const,
  summary: "Clear completed tasks",
  status: "To Do",
};
const draft = {
  summary: story.summary,
  description: "Provide a button on the task list.",
  acceptanceCriteria: [
    "Only the signed-in owner's completed tasks are cleared.",
  ],
};

async function fixture(t: TestContext, active = story.key) {
  const root = await mkdtemp(join(tmpdir(), "qa-jira-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const get = async (file: string) =>
    JSON.parse(await readFile(join(root, file), "utf8"));
  const put = async (file: string, value: unknown) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  const featureFile = `qa/${active}/feature.json`;
  const current = { storyKey: active, featureFile };
  await put("qa/current.json", current);
  await put("qa/pipeline.json", { stages: ["story", "requirements", "done"] });
  await put(featureFile, {
    storyKey: active,
    stage: "executed",
    paused: false,
    completedStages: ["requirements", "reviewed", "branch-ready", "executed"],
    pendingStages: ["done"],
    nextCommand: "qa close",
  });
  return { root, get, put, current, featureFile };
}

test("key intake is read-only even for a paused Story", async (t) => {
  const f = await fixture(t, "KAN-29");
  assert.deepEqual(await prepareJira(f.root, "qa story kan-29", { cloudId }), {
    kind: "intake",
    cloudId,
    storyKey: "KAN-29",
  });
  assert.deepEqual(await f.get("qa/current.json"), f.current);
  await assert.rejects(
    prepareJira(f.root, "qa implement", { cloudId }),
    /paused/,
  );
});

test("creation binds the exact preview and bootstraps only after verified readback", async (t) => {
  const f = await fixture(t, "KAN-25");
  const command = "qa story Clear completed tasks";
  const input = { cloudId, draft };
  const preview = await prepareJira(f.root, command, input);
  assert.equal(preview.kind, "create");
  if (preview.kind !== "create") throw new Error("Missing creation preview");
  assert.equal(preview.arguments.projectKey, "KAN");
  assert.match(
    preview.arguments.description,
    /## Acceptance criteria\n\n- Only/,
  );
  await assert.rejects(
    approvedJira(f.root, command, input, preview, ""),
    /requires OK/,
  );
  await assert.rejects(
    approvedJira(
      f.root,
      command,
      { cloudId, draft: { ...draft, summary: "Changed" } },
      preview,
      "OK",
    ),
    /requires OK/,
  );
  const created = {
    ...story,
    description:
      "Provide a **button** on the task list.\r\n\r\n### Acceptance criteria\r\n\r\n1. Only the signed-in owner's\r\n   *completed tasks* are cleared.",
  };
  const identity = { key: story.key, id: story.id };
  await assert.rejects(
    recordJira(f.root, command, input, preview, "OK", created, {
      ...identity,
      key: "KAN-52",
    }),
    /readback/,
  );
  await assert.rejects(
    recordJira(
      f.root,
      command,
      input,
      preview,
      "OK",
      { ...created, description: draft.description },
      identity,
    ),
    /readback/,
  );
  await assert.rejects(
    recordJira(
      f.root,
      command,
      input,
      preview,
      "OK",
      {
        ...created,
        summary: "Other story",
      },
      identity,
    ),
    /readback/,
  );
  assert.deepEqual(await f.get("qa/current.json"), f.current);
  await recordJira(f.root, command, input, preview, "OK", created, identity);
  const file = "qa/KAN-51/feature.json";
  assert.deepEqual(await f.get("qa/current.json"), {
    storyKey: story.key,
    featureFile: file,
  });
  assert.deepEqual(await f.get(file), {
    storyKey: story.key,
    title: story.summary,
    stage: "story",
    paused: false,
    completedStages: ["story"],
    pendingStages: ["requirements", "done"],
    nextCommand: "qa requirements",
  });
});

test("transition preview uses the available ID and Done requires matching readback", async (t) => {
  const f = await fixture(t);
  const input = {
    cloudId,
    story,
    transitions: [
      { id: "21", name: "Start work", to: "In Progress" },
      { id: "31", name: "Finish", to: "Done" },
    ],
  };
  const start = await prepareJira(f.root, "qa implement", input);
  assert.equal(start.kind, "transition");
  if (start.kind !== "transition")
    throw new Error("Missing transition preview");
  assert.equal(start.arguments.transitionId, "21");
  await recordJira(f.root, "qa implement", input, start, "OK", {
    ...story,
    status: "In Progress",
  });
  assert.equal((await f.get(f.featureFile)).stage, "executed");
  const close = await prepareJira(f.root, "qa close", input);
  await assert.rejects(
    approvedJira(
      f.root,
      "qa close",
      { ...input, transitions: [{ id: "99", name: "Finish", to: "Done" }] },
      close,
      "OK",
    ),
    /requires OK/,
  );
  await assert.rejects(
    recordJira(f.root, "qa close", input, close, "OK", story),
    /readback/,
  );
  assert.equal((await f.get(f.featureFile)).stage, "executed");
  await recordJira(f.root, "qa close", input, close, "OK", {
    ...story,
    status: "Done",
  });
  const closed = await f.get(f.featureFile);
  assert.equal(closed.stage, "done");
  assert.equal(closed.completedStages.at(-1), "done");
  assert.deepEqual(closed.pendingStages, []);
  assert.equal(closed.nextCommand, undefined);
});

async function receiptFixture(t: TestContext) {
  const f = await fixture(t);
  const dir = "artifacts/qa/" + story.key;
  const browser = story.key + "-TC-01";
  const local = story.key + "-TC-02";
  const design =
    "# " +
    story.key +
    "\n" +
    [
      [browser, "Playwright"],
      [local, "JSDOM"],
    ]
      .map(([id, level]) =>
        [
          "## " + id + " — Reviewed case",
          "- Level: " + level,
          "- Preconditions: Isolated fixture",
          "| Step | Action | Test data | Expected observable result |",
          "| --- | --- | --- | --- |",
          "| 1 | Run case | Synthetic data | Result is observable |",
        ].join("\n"),
      )
      .join("\n");
  const designDigest = fingerprint(design);
  const scope = { xray: [browser!], local: [local!] };
  const review =
    "- Decision: accepted for design.\n- testDesign " +
    designDigest.slice(7) +
    "\n- Lifecycle evidence scope: " +
    objectDigest({ designHash: designDigest, scope });
  const mergeCommit = "a".repeat(40);
  const ciRunId = "123";
  const planKey = "KAN-60";
  const executionKey = "KAN-62";
  await f.put(f.featureFile, {
    ...(await f.get(f.featureFile)),
    completedStages: ["reviewed", "executed", "published"],
    testPlanKey: planKey,
    testExecutionKey: "KAN-61",
    evidence: {
      testDesign: dir + "/design.md",
      testReview: dir + "/review.md",
    },
    verifiedRecords: {
      postMergeExecution: {
        testExecutionKey: executionKey,
        ciRunId,
        mergeCommit,
        branch: "main",
      },
    },
  });
  await mkdir(join(f.root, dir), { recursive: true });
  await writeFile(join(f.root, dir, "design.md"), design);
  await writeFile(join(f.root, dir, "review.md"), review);
  await f.put(dir + "/xray-test-keys.json", { [browser]: "KAN-63" });
  const receipt = {
    storyKey: story.key,
    planKey,
    mergeCommit,
    ciRunId,
    branch: "main",
    event: "push",
    importConclusion: "success",
    evidenceDigest: fingerprint("verified synthetic run"),
    execution: { key: executionKey, id: "10062", issueType: "Test Execution" },
    designDigest,
    imported: [{ caseId: browser, testKey: "KAN-63", outcome: "passed" }],
    local: [{ caseId: local, outcome: "passed" }],
  };
  const input = {
    cloudId,
    story: { ...story, status: "In Progress" },
    transitions: [{ id: "41", name: "Finish", to: "Done" }],
    delivery: {
      mergeCommit,
      ciHead: mergeCommit,
      ciRunId,
      conclusion: "success",
      postMergeImport: { state: "verified", executionKey, receipt },
    },
  };
  return { f, input, dir };
}

test("qa close accepts complete approved mixed CI receipt and still requires exact OK and Done readback", async (t) => {
  const { f, input } = await receiptFixture(t);
  const preview = await prepareJira(f.root, "qa close", input);
  await assert.rejects(
    approvedJira(f.root, "qa close", input, preview, "yes"),
    /requires OK/,
  );
  const revised = structuredClone(input);
  revised.delivery.postMergeImport.receipt.evidenceDigest = fingerprint(
    "different verified receipt",
  );
  await assert.rejects(
    approvedJira(f.root, "qa close", revised, preview, "OK"),
    /requires OK/,
  );
  await assert.rejects(
    recordJira(f.root, "qa close", input, preview, "OK", input.story),
    /readback/,
  );
  await recordJira(f.root, "qa close", input, preview, "OK", {
    ...input.story,
    status: "Done",
  });
  assert.equal((await f.get(f.featureFile)).stage, "done");
});

test("qa close refuses unsuccessful, mismatched, or incomplete post-merge receipts", async (t) => {
  const { f, input, dir } = await receiptFixture(t);
  const good = input.delivery.postMergeImport.receipt;
  for (const patch of [
    { storyKey: "KAN-99" },
    { planKey: "KAN-99" },
    { mergeCommit: "b".repeat(40) },
    { ciRunId: "456" },
    { branch: "feature" },
    { event: "pull_request" },
    { execution: { ...good.execution, key: "KAN-61" } },
    { importConclusion: "failure" },
    { importConclusion: "skipped" },
    { evidenceDigest: undefined },
    { local: [] },
    { local: [{ ...good.local[0], outcome: "failed" }] },
    { imported: [{ ...good.imported[0], outcome: "skipped" }] },
    { imported: [...good.imported, ...good.imported] },
    { imported: [{ ...good.imported[0], testKey: "KAN-99" }] },
    {
      imported: [
        ...good.imported,
        { caseId: story.key + "-TC-99", testKey: "KAN-99", outcome: "passed" },
      ],
    },
  ]) {
    await assert.rejects(
      prepareJira(f.root, "qa close", {
        ...input,
        delivery: {
          ...input.delivery,
          postMergeImport: {
            ...input.delivery.postMergeImport,
            receipt: { ...good, ...patch },
          },
        },
      }),
      JSON.stringify(patch),
    );
  }
  const withoutReceipt = {
    ...input,
    delivery: {
      ...input.delivery,
      postMergeImport: {
        state: "verified",
        executionKey: good.execution.key,
      },
    },
  };
  await assert.rejects(prepareJira(f.root, "qa close", withoutReceipt));
  await f.put(dir + "/xray-test-keys.json", {
    [good.imported[0]!.caseId]: "KAN-99",
  });
  await assert.rejects(
    prepareJira(f.root, "qa close", input),
    /complete reviewed case-to-Test scope/,
  );
});
