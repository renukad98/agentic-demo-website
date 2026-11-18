import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after } from "node:test";
import type { Identity } from "../../../tools/agentic/contracts/index.js";
import { fingerprint, objectDigest } from "../../../tools/agentic/artifacts.js";
import {
  bindingBehaviorDigest,
  bindingEvidenceDigest,
} from "../../../tools/xray/identity.js";

// Hand-authored inputs for offline tests. No production reports or journals are copied.
const source = "// Synthetic source fingerprint input.\n";
const sourceLocation = "tests/e2e/synthetic.spec.ts";
const runnerId = "synthetic-playwright-case-22";
const testTitle = "Synthetic single-submit behavior";
export const registryFile =
  "artifacts/qa/automation-identities/registry-v1.json";
export const manualCaseFile =
  "artifacts/qa/KAN-25/orchestration-demo-20261117-100046/test-cases.md";
export const fixtureStart = "2025-01-02T03:04:05.100Z";
export const fixtureFinish = "2025-01-02T03:04:06.334Z";

export const syntheticBrowserReport = JSON.stringify({
  errors: [],
  stats: { duration: 1234, expected: 1, unexpected: 0, flaky: 0 },
  suites: [
    {
      specs: [
        {
          id: runnerId,
          title: testTitle,
          file: "synthetic.spec.ts",
          tests: [
            {
              projectName: "chromium",
              status: "expected",
              expectedStatus: "passed",
              results: [
                {
                  status: "passed",
                  retry: 0,
                  duration: 1234,
                  startTime: fixtureStart,
                  errors: [],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});
export const syntheticNodeReport =
  '<testsuites><testsuite><testcase file="synthetic.test.ts" name="Synthetic pass"/></testsuite></testsuites>';
const reportPath = "artifacts/qa/synthetic/playwright.json";
const sourceFiles = { [sourceLocation]: fingerprint(source) };
const binding = {
  schemaVersion: "1.0.0",
  framework: "playwright",
  projectName: "chromium",
  testTitle,
  runnerIds: [runnerId],
  sourceFiles,
  historicalExecutions: [
    {
      // The selector is a production contract. The runner, bytes, source and dates are synthetic.
      runId: "phase5d-20261116-150241",
      artifactPath: reportPath,
      artifactDigest: fingerprint(syntheticBrowserReport),
      runnerId,
      testTitle,
      projectName: "chromium",
      outcome: "passed",
    },
  ],
} as const;
const identity: Identity = {
  schemaVersion: "1.0.0",
  repository: "agentic-demo-website",
  runner: "playwright",
  automationId: "task-create-inflight-single-submit-v1",
  sourceLocation,
  sourceDigest: objectDigest(sourceFiles),
  behaviorDigest: fingerprint("pending"),
  associations: [
    {
      storyKey: "KAN-25",
      scenarioIds: ["TM-TC-22"],
      requirementIds: ["TM-REQ-014"],
      acceptanceIds: ["TM-AC-19"],
    },
  ],
  binding: {
    ...binding,
    runnerIds: [...binding.runnerIds],
    historicalExecutions: [...binding.historicalExecutions],
  },
};
identity.behaviorDigest = bindingBehaviorDigest(identity);
export const fixtureSourceDigest = identity.sourceDigest;
export const fixtureEvidenceDigest = bindingEvidenceDigest(identity);

const manualCases = [
  "Story KAN-25; synthetic fixture.",
  "## TM-TC-01 — Synthetic legacy case",
  "- Requirements: TM-REQ-001.",
  "- Acceptance: TM-AC-01.",
  "- Planned level: DOM.",
  "- Preconditions/data: Synthetic shared data.",
  "| Step | Action / input | Expected observable result |",
  "| --- | --- | --- |",
  "| 1 | Submit fixture. | Fixture appears. |",
  "## TM-TC-22 — Synthetic structured case",
  "- Requirements: TM-REQ-014, TM-REQ-015.",
  "- Acceptance: TM-AC-19.",
  "- Planned level: DOM.",
  "- Preconditions/data: Synthetic controls and isolated fixture.",
  "| Step | Action | Test data | Expected observable result |",
  "| --- | --- | --- | --- |",
  ...Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    return `| ${n} | Act on fixture ${n}. | Sample input ${n}. | Observe fixture ${n}. |`;
  }),
  "## TM-TC-24 — Synthetic non-executable audit",
  "- Planned level: delivery review.",
].join("\n");

export async function createDemoEvidenceFixture() {
  const root = await mkdtemp(
    join(tmpdir(), "agentic-demo-synthetic-evidence-"),
  );
  after(() => rm(root, { recursive: true, force: true }));
  for (const [path, body] of Object.entries({
    [sourceLocation]: source,
    [reportPath]: syntheticBrowserReport,
    [registryFile]: JSON.stringify({
      schemaVersion: "1.0.0",
      identities: [identity],
    }),
    [manualCaseFile]: manualCases,
  })) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}
