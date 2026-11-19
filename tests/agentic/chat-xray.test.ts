import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fingerprint } from "../../tools/agentic/artifacts.js";
import {
  completeChatXray,
  loadChatXray,
  recordChatXrayKey,
  renderChatXrayPreview,
  reviewChatXrayDuplicates,
} from "../../tools/agentic/chat-xray.js";

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "chat-xray-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path: string, content: string | object) => {
    const destination = join(root, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(
      destination,
      typeof content === "string" ? content : JSON.stringify(content),
    );
  };
  await put("qa/current.json", {
    storyKey: "QA-12",
    featureFile: "qa/QA-12/feature.json",
  });
  await put("qa/pipeline.json", {
    commands: { "qa xray": { chatManualTests: {} } },
  });
  for (const story of ["QA-12", "KAN-25"]) {
    const dir = `artifacts/qa/${story}/review-1`;
    const testDesign = `${dir}/test-cases.md`;
    const testReview = `${dir}/review.md`;
    const design = [
      `# ${story} test design`,
      "",
      `## ${story}-TC-001 — Cancel deletion`,
      "- Preconditions: Sign in with a disposable task.",
      "| Step | Action | Test data | Expected observable result |",
      "| --- | --- | --- | --- |",
      "| 1 | Click `Cancel` | Owned task | The task remains. |",
    ].join("\n");
    await put(testDesign, design);
    await put(
      testReview,
      `- Decision: accepted for design.\n  - \`testDesign ${fingerprint(design).slice(7)}\`\n`,
    );
    await put(`qa/${story}/feature.json`, {
      storyKey: story,
      stage: "reviewed",
      completedStages: ["story", "reviewed"],
      pendingStages: ["branch-ready", "implemented", "published", "in-review"],
      evidence: { testDesign, testReview, traceability: "traceability.csv" },
    });
  }
  return { root, put };
}

test("qa xray defaults to the current Story and an explicit key overrides it", async (t) => {
  const { root, put } = await fixture(t);
  const current = await loadChatXray(root, "qa xray");
  assert.equal(current.storyKey, "QA-12");
  assert.equal(current.folderPath, undefined);
  await put("qa/current.json", "unreadable pointer");
  await put("qa/pipeline.json", {
    commands: { "qa xray": { chatManualTests: { folderPath: "/Tasks" } } },
  });
  const explicit = await loadChatXray(root, "qa xray KAN-25");
  assert.equal(explicit.featureFile, "qa/KAN-25/feature.json");
  assert.equal(explicit.folderPath, "/Tasks");
  assert.deepEqual(explicit.cases, [
    {
      caseId: "KAN-25-TC-001",
      summary: "KAN-25-TC-001: Cancel deletion",
      steps: [
        {
          action: "Preconditions: Sign in with a disposable task.",
          data: "",
          result: "Preconditions met",
        },
        {
          action: "Click `Cancel`",
          data: "Owned task",
          result: "The task remains.",
        },
      ],
    },
  ]);
  await assert.rejects(loadChatXray(root, "qa xray KAN-29"), /paused/);
  await assert.rejects(
    loadChatXray(root, "qa xray QA-999"),
    /No QA feature record for QA-999/,
  );
  await assert.rejects(
    loadChatXray(root, "qa xray KAN-25 QA-12"),
    /Use qa xray/,
  );
  await put(
    "artifacts/qa/KAN-25/review-1/test-cases.md",
    "# Changed after review",
  );
  await assert.rejects(
    loadChatXray(root, "qa xray KAN-25"),
    /exact testDesign SHA-256/,
  );
});

test("duplicate review paginates before deciding create, reuse, or skip", async (t) => {
  const { root } = await fixture(t);
  const plan = await loadChatXray(root, "qa xray");
  const item = plan.cases[0]!;
  const match = { issueId: "102", key: "QA-102", summary: item.summary };
  const unrelated = { issueId: "101", key: "QA-101", summary: "Unrelated" };
  const calls: number[] = [];
  const list = async (start: number) => {
    calls.push(start);
    return { total: 2, results: [start === 0 ? unrelated : match] };
  };
  for (const [linked, decision] of [
    [false, "reuse"],
    [true, "skip"],
  ] as const) {
    const rows = await reviewChatXrayDuplicates(
      plan.cases,
      list,
      async (candidate) => ({
        ...candidate,
        manual: true,
        linked,
        steps: item.steps,
      }),
      {},
    );
    assert.equal(rows[0]?.decision, decision);
  }
  assert.deepEqual(calls, [0, 1, 0, 1]);
  const empty = await reviewChatXrayDuplicates(
    plan.cases,
    async () => ({ total: 0, results: [] }),
    async () => assert.fail("Empty inventory must not inspect a test"),
    {},
  );
  assert.equal(empty[0]?.decision, "create");
  const preview = { ...plan, rows: empty };
  const readOnly = renderChatXrayPreview(
    preview,
    "https://jira.example",
    false,
  );
  assert.match(readOnly, /XRAY_ENABLE_WRITES/);
  assert.doesNotMatch(readOnly, /Reply OK/);
  assert.match(readOnly, /Preconditions met.*Click &#96;Cancel&#96;/);
  assert.match(
    renderChatXrayPreview(preview, "https://jira.example", true),
    /Reply OK to approve these exact Manual Test creations and Story links\.$/,
  );
  await assert.rejects(
    reviewChatXrayDuplicates(
      plan.cases,
      list,
      async (candidate) => ({
        ...candidate,
        manual: true,
        linked: false,
        steps: [],
      }),
      {},
    ),
    /Unresolved/,
  );
});

test("duplicate case IDs match as whole tokens", async () => {
  const steps = [
    { action: "Open Tasks", data: "", result: "Tasks are visible" },
  ];
  const reviewed = { caseId: "TM-TC-1", summary: "TM-TC-1: Open Tasks", steps };
  const exact = {
    issueId: "10",
    key: "KAN-10",
    summary: "Legacy (tm-tc-1): Open Tasks",
  };
  const prefix = {
    issueId: "11",
    key: "KAN-11",
    summary: "TM-TC-10: Open Tasks",
  };
  const rows = await reviewChatXrayDuplicates(
    [reviewed],
    async () => ({ total: 2, results: [prefix, exact] }),
    async (candidate) => {
      assert.deepEqual(candidate, exact);
      return { ...candidate, manual: true, linked: true, steps };
    },
    {},
  );
  assert.equal(rows[0]?.decision, "skip");
  const onlyPrefix = await reviewChatXrayDuplicates(
    [reviewed],
    async () => ({ total: 1, results: [prefix] }),
    async () => assert.fail("TM-TC-10 must not be inspected for TM-TC-1"),
    {},
  );
  assert.equal(onlyPrefix[0]?.decision, "create");
});

test("key mapping is durable before completion and conflicts leave the Story pending", async (t) => {
  const { root } = await fixture(t);
  const plan = await loadChatXray(root, "qa xray KAN-25");
  const caseKey = "KAN-25-TC-001";
  await recordChatXrayKey(root, plan.storyKey, caseKey, "KAN-90");
  await assert.rejects(
    recordChatXrayKey(root, plan.storyKey, caseKey, "KAN-91"),
    /Conflicting/,
  );
  await assert.rejects(
    completeChatXray(root, "qa xray KAN-25", "old digest", {}),
    /changed/,
  );
  await assert.rejects(
    completeChatXray(root, "qa xray KAN-25", plan.evidenceDigest, {}),
    /Every reviewed case/,
  );
  const featurePath = join(root, plan.featureFile);
  assert.equal(
    JSON.parse(await readFile(featurePath, "utf8")).stage,
    "reviewed",
  );
  await completeChatXray(root, "qa xray KAN-25", plan.evidenceDigest, {
    [caseKey]: "KAN-90",
  });
  const feature = JSON.parse(await readFile(featurePath, "utf8"));
  assert.equal(feature.stage, "published");
  assert.equal(feature.nextCommand, "qa branch");
  assert.equal(feature.evidence.traceability, "traceability.csv");
  assert.deepEqual(feature.pendingStages, [
    "branch-ready",
    "implemented",
    "in-review",
  ]);
  assert.equal((await loadChatXray(root, "qa xray")).storyKey, "QA-12");
});
