import type { Identity } from "../../tools/agentic/contracts/index.js";
import { fingerprint, objectDigest } from "../../tools/agentic/artifacts.js";
import { bindingBehaviorDigest } from "../../tools/xray/identity.js";

export const mockCreation = {
  projectId: "100",
  issueTypeId: "104",
  reporter: { accountId: "mock-reporter-01" },
};
export const fixtureSource = "synthetic test source";
export const fixtureReport = JSON.stringify({
  suites: [
    {
      specs: [
        {
          id: "historical-runner-1",
          title: "Synthetic behavior",
          file: "synthetic.spec.ts",
          tests: [{ projectName: "chromium", results: [{ status: "passed" }] }],
        },
      ],
    },
  ],
});
export function boundFixture(raw?: Identity): Identity {
  const identity: Identity = raw
    ? structuredClone(raw)
    : {
        schemaVersion: "1.0.0",
        repository: "synthetic-repository",
        runner: "playwright",
        automationId: "synthetic-behavior-v1",
        sourceLocation: "tests/e2e/synthetic.spec.ts",
        behaviorDigest: fingerprint("pending"),
        sourceDigest: fingerprint("pending"),
        associations: [
          {
            storyKey: "SYN-1",
            scenarioIds: ["C1"],
            requirementIds: ["R1"],
            acceptanceIds: ["A1"],
          },
        ],
      };
  identity.binding = {
    schemaVersion: "1.0.0",
    framework: identity.runner === "playwright" ? "playwright" : "node:test",
    ...(identity.runner === "playwright" ? { projectName: "chromium" } : {}),
    testTitle: "Synthetic behavior",
    runnerIds: ["historical-runner-1"],
    sourceFiles: { [identity.sourceLocation]: fingerprint(fixtureSource) },
    historicalExecutions: [
      {
        runId: "synthetic-run-1",
        artifactPath: "artifacts/qa/SYN-1/synthetic-run-1/results.json",
        artifactDigest: fingerprint(fixtureReport),
        runnerId: "historical-runner-1",
        testTitle: "Synthetic behavior",
        ...(identity.runner === "playwright"
          ? { projectName: "chromium" }
          : {}),
        outcome: "passed",
      },
    ],
  };
  identity.sourceDigest = objectDigest(identity.binding.sourceFiles);
  identity.behaviorDigest = bindingBehaviorDigest(identity);
  if (identity.xray) identity.xray.behaviorDigest = identity.behaviorDigest;
  return identity;
}
