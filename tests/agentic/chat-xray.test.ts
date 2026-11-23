import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveQaNext } from "../../tools/agentic/qa-next.js";
import { fingerprint, objectDigest } from "../../tools/agentic/artifacts.js";
import {
  completeChatXray,
  loadChatXray,
  markChatXrayPublished,
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

test("stage-only pause blocks Manual Test preflight and completion", async (t) => {
  const { root, put } = await fixture(t);
  const plan = await loadChatXray(root, "qa xray");
  const feature = JSON.parse(
    await readFile(join(root, plan.featureFile), "utf8"),
  );
  const paused = { ...feature, stage: "paused" };
  assert.equal(paused.paused, undefined);
  await put(plan.featureFile, paused);
  await assert.rejects(loadChatXray(root, "qa xray"), /paused/);
  await assert.rejects(markChatXrayPublished(root, paused), /paused/);
  await assert.rejects(
    completeChatXray(root, "qa xray", plan.evidenceDigest, {}),
    /paused/,
  );
});

for (const state of [
  "feature-development",
  "agent-06",
  "stale",
  "refreshed-design",
  "refreshed-source",
  "refreshed-test",
  "refreshed-mappings",
  "legacy-equivalent",
  "refreshed-legacy",
] as const) {
  test(
    "publication and qa next agree for " + state + " case evidence",
    async (t) => {
      const { root, put } = await fixture(t);
      const featurePath = "qa/QA-12/feature.json";
      const feature = JSON.parse(
        await readFile(join(root, featurePath), "utf8"),
      );
      const reference = async (path: string) => ({
        path,
        digest: fingerprint(await readFile(join(root, path))),
      });
      const proofPath = "artifacts/qa/QA-12/review-1/coverage-proof.json";
      const coverage = "artifacts/qa/QA-12/review-1/coverage-review.md";
      const caseMappings = "artifacts/qa/QA-12/review-1/mappings.json";
      const source = "src/qa-12.ts";
      const testFile = "tests/qa-12.test.ts";
      const legacy =
        state === "legacy-equivalent" || state === "refreshed-legacy";
      const blocked = state === "stale" || state.startsWith("refreshed-");
      await put(source, "synthetic source");
      await put(testFile, "synthetic test contents");
      await put(caseMappings, [
        {
          caseId: "QA-12-TC-001",
          file: testFile,
          title: "checks cancellation",
        },
      ]);
      const revision = async () => ({
        storyKey: "QA-12",
        kind: legacy
          ? "legacy-equivalent"
          : state === "feature-development"
            ? state
            : "agent-06",
        design: await reference(feature.evidence.testDesign),
        designReview: await reference(feature.evidence.testReview),
        caseMappings: await reference(caseMappings),
        sourceFiles: {
          [source]: (await reference(source)).digest,
          [testFile]: (await reference(testFile)).digest,
        },
      });
      const original = await revision();
      await put(
        coverage,
        [
          "- Decision: accepted for case implementation.",
          "- Coverage revision: " + objectDigest(original),
          "Existing test covers QA-12-TC-001.",
        ].join("\n"),
      );
      if (state === "refreshed-design") {
        const design = await readFile(
          join(root, feature.evidence.testDesign),
          "utf8",
        );
        const changed = design.replace(
          "The task remains.",
          "The owned task remains visible.",
        );
        await put(feature.evidence.testDesign, changed);
        await put(
          feature.evidence.testReview,
          "- Decision: accepted for design.\n- testDesign " +
            fingerprint(changed).slice(7),
        );
      }
      if (state === "refreshed-source") await put(source, "changed source");
      if (["stale", "refreshed-test", "refreshed-legacy"].includes(state))
        await put(testFile, "changed after coverage review");
      if (state === "refreshed-mappings")
        await put(caseMappings, [
          { caseId: "QA-12-TC-001", file: testFile, title: "new exact title" },
        ]);
      await put(proofPath, {
        ...(state.startsWith("refreshed-") ? await revision() : original),
        coverageReview: await reference(coverage),
      });
      await put(featurePath, {
        ...feature,
        stage: "automated",
        completedStages: [
          ...feature.completedStages,
          "implemented",
          ...(legacy ? [] : ["tests-implemented"]),
        ],
        pendingStages: ["published", "executed", "in-review"],
        evidence: { ...feature.evidence, testImplementation: proofPath },
      });
      const plan = await loadChatXray(root, "qa xray");
      await recordChatXrayKey(root, "QA-12", "QA-12-TC-001", "QA-90");
      await completeChatXray(root, "qa xray", plan.evidenceDigest, {
        "QA-12-TC-001": "QA-90",
      });
      const published = JSON.parse(
        await readFile(join(root, featurePath), "utf8"),
      );
      const route = await resolveQaNext(root, published);
      assert.equal(published.stage, "published");
      assert.equal(published.nextCommand, blocked ? "qa implement" : "qa run");
      assert.deepEqual(
        published.pendingStages,
        blocked
          ? ["implemented", "executed", "in-review"]
          : ["executed", "in-review"],
      );
      assert.deepEqual(route, {
        pendingStages: published.pendingStages,
        nextCommand: published.nextCommand,
      });
      if (state === "refreshed-test") {
        const current = await revision();
        await put(
          coverage,
          "- Decision: accepted for case implementation.\n- Coverage revision: " +
            objectDigest(current),
        );
        await put(proofPath, {
          ...current,
          coverageReview: await reference(coverage),
        });
        assert.deepEqual(await resolveQaNext(root, published), {
          pendingStages: ["executed", "in-review"],
          nextCommand: "qa run",
        });
      }
      if (legacy)
        assert.equal(
          published.completedStages.includes("tests-implemented"),
          false,
        );
    },
  );
}
