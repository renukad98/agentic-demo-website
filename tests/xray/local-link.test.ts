import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { previewRestLink, runRestLink } from "../../tools/xray/local-link.js";
import {
  localLinkTarget,
  localLinkTargets,
  type LocalLinkTarget,
} from "../../tools/xray/local-link-target.js";

const digest = ("sha256:" + "a".repeat(64)) as `sha256:${string}`;
const tenant = "renudhamankar98.atlassian.net";

async function fixture(
  t: TestContext,
  testKey: LocalLinkTarget = "KAN-26",
  confirmed = true,
) {
  const target = localLinkTargets[testKey];
  const directory = await mkdtemp(join(tmpdir(), "xray-local-link-"));
  const journal = new OperationJournal(directory);
  t.after(async () => {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = {
    schemaVersion: "1.0.0" as const,
    operationId: "a-test",
    storyKey: "KAN-25",
    operation: "xray.test.create" as const,
    payloadDigest: digest,
    tenant,
    projectKey: "KAN",
    sourceDigest: digest,
    evidenceDigest: digest,
    automationIdentity: target.identity,
    remoteIds: [],
  };
  for (const status of [
    "Planned",
    "Awaiting approval",
    "Approved",
    "Attempted",
    "Confirmed",
  ] as const) {
    if (!confirmed && status === "Confirmed") break;
    await journal.record({
      ...base,
      status,
      at: new Date().toISOString(),
      ...(["Approved", "Attempted", "Confirmed"].includes(status)
        ? {
            approvalReference: "a-approval",
            approvalConsumptionId: "a-consumption",
          }
        : {}),
      ...(status === "Confirmed"
        ? { remoteIds: [target.issueId], remoteTestKey: testKey }
        : {}),
    });
  }
  if (testKey === "KAN-28") {
    for (const status of [
      "Planned",
      "Awaiting approval",
      "Approved",
      "Attempted",
      "Confirmed",
    ] as const) {
      await journal.record({
        ...base,
        operationId: "generic-link",
        operation: "jira.test.link",
        status,
        payloadDigest: ("sha256:" + "b".repeat(64)) as typeof digest,
        automationIdentity: localLinkTargets["KAN-26"].identity,
        remoteTestKey: "KAN-26",
        at: new Date().toISOString(),
        remoteIds: status === "Confirmed" ? ["10010"] : [],
        ...(["Approved", "Attempted", "Confirmed"].includes(status)
          ? {
              approvalReference: "generic-approval",
              approvalConsumptionId: "generic-consumption",
            }
          : {}),
      });
    }
  }
  const state = {
    posts: 0,
    linked: false,
    covered: false,
    lost: false,
    reverse: false,
    steps: 9,
  };
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(new URL(String(url)).origin, "https://" + tenant);
    const path = new URL(String(url)).pathname;
    if (options?.method === "POST") {
      assert.equal(path, "/rest/api/3/issueLink");
      assert.deepEqual(JSON.parse(String(options.body)), {
        type: { id: "10037" },
        inwardIssue: { key: testKey },
        outwardIssue: { key: "KAN-25" },
      });
      assert.equal(
        (await journal.latestEntries()).find(
          (entry) =>
            entry.operation === "jira.test.link" &&
            entry.remoteTestKey === testKey,
        )?.status,
        "Attempted",
      );
      state.posts++;
      state.linked = true;
      if (state.lost) throw new Error("mock lost response");
      return new Response(null, { status: 201 });
    }
    if (path.endsWith("/issueLinkType/10037"))
      return Response.json({
        id: "10037",
        name: "Test",
        inward: "is tested by",
        outward: "tests",
      });
    const story = path.endsWith("/issue/KAN-25");
    if (!story) assert.ok(path.endsWith("/issue/" + testKey));
    return Response.json({
      id: story ? "10065" : target.issueId,
      key: story ? "KAN-25" : testKey,
      fields: {
        issuetype: { id: story ? "10009" : "10045" },
        issuelinks: [
          ...(story && testKey === "KAN-28"
            ? [
                {
                  id: "10010",
                  type: { id: "10037", name: "Test" },
                  inwardIssue: { key: "KAN-26" },
                },
              ]
            : []),
          ...(state.linked
            ? [
                {
                  id: "10500",
                  type: { id: "10037", name: "Test" },
                  [story !== state.reverse ? "inwardIssue" : "outwardIssue"]: {
                    key: story ? testKey : "KAN-25",
                  },
                },
              ]
            : []),
        ],
      },
    });
  };
  const ports = {
    fetch: fetcher,
    credentials: {
      baseUrl: "https://" + tenant,
      email: "mock@example.com",
      token: "mock-token",
    },
    xray: {
      async getTest() {
        return {
          issueId: target.issueId,
          jira: { key: testKey },
          testType: { name: target.type },
          unstructured: target.type === "Generic" ? target.identity : null,
          steps: Array.from({ length: state.steps }, () => ({
            action: "Act",
            data: "Data",
            result: "Result",
          })),
        };
      },
      async getManualTest() {
        const test = await this.getTest();
        return {
          ...test,
          jira: {
            ...test.jira,
            description: "Manual case: " + target.identity,
          },
        };
      },
      async getCoverage() {
        return state.covered
          ? [{ issueId: "10065", jira: { key: "KAN-25" } }]
          : [];
      },
    },
  };
  return { state, journal, ports };
}

test("persists one attempt and verifies the directional Jira link and Xray coverage", async (t) => {
  const { state, journal, ports } = await fixture(t);
  const [creation] = await journal.latestEntries();
  const review = await previewRestLink(journal);
  const result = await runRestLink(journal, {
    ...ports,
    async confirm(display) {
      assert.deepEqual(JSON.parse(display), review);
      return "APPROVE " + review.fingerprint;
    },
    fetch: async (url, options) => {
      const response = await ports.fetch(url, options);
      if (options?.method === "POST") state.covered = true;
      return response;
    },
  });
  assert.deepEqual(result, { status: "CONFIRMED", linkId: "10500" });
  assert.deepEqual((await journal.latestEntries())[0], creation);
  assert.equal((await runRestLink(journal, ports)).status, "ALREADY_JOURNALED");
  assert.equal(state.posts, 1);
});

test("KAN-28 selection previews and confirms separately while preserving the existing Generic link", async (t) => {
  const { state, journal, ports } = await fixture(t, "KAN-28");
  assert.equal(localLinkTarget(), "KAN-26");
  assert.throws(
    () => localLinkTarget("KAN-27"),
    /UNSUPPORTED_LOCAL_LINK_TARGET/,
  );
  const before = await journal.latestEntries();
  const preview = await runRestLink(
    journal,
    { ...ports, previewOnly: true },
    "KAN-28",
  );
  assert.equal(preview.status, "PREVIEW");
  const expected = await previewRestLink(journal, "KAN-28");
  assert.equal(
    expected.fingerprint,
    "sha256:4e5583d31aa9b7c0f0fcacc8716d8b6328d2e597dc53332d6aa3340e85b58f72",
  );
  assert.deepEqual(preview, { status: "PREVIEW", ...expected });
  assert.equal(state.posts, 0);
  const result = await runRestLink(
    journal,
    {
      ...ports,
      async confirm(display) {
        assert.deepEqual(JSON.parse(display), expected);
        return "APPROVE " + expected.fingerprint;
      },
      async fetch(url, options) {
        const response = await ports.fetch(url, options);
        if (options?.method === "POST") state.covered = true;
        return response;
      },
    },
    "KAN-28",
  );
  assert.deepEqual(result, { status: "CONFIRMED", linkId: "10500" });
  assert.deepEqual(
    (await journal.latestEntries()).slice(0, before.length),
    before,
  );
});

test("KAN-28 requires a Confirmed creation and nine steps at preflight", async (t) => {
  const pending = await fixture(t, "KAN-28", false);
  await assert.rejects(
    runRestLink(pending.journal, pending.ports, "KAN-28"),
    /CONFIRMATION_REQUIRED/,
  );
  const confirmed = await fixture(t, "KAN-28");
  confirmed.state.steps = 8;
  await assert.rejects(
    runRestLink(confirmed.journal, confirmed.ports, "KAN-28"),
    /MANUAL_LINK_PREFLIGHT_MISMATCH/,
  );
  assert.equal(confirmed.state.posts, 0);
});

test("KAN-28 revalidates after approval and rejects a newly discovered duplicate", async (t) => {
  const { state, journal, ports } = await fixture(t, "KAN-28");
  await assert.rejects(
    runRestLink(
      journal,
      {
        ...ports,
        async confirm() {
          return "APPROVE wrong";
        },
      },
      "KAN-28",
    ),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  await assert.rejects(
    runRestLink(
      journal,
      {
        ...ports,
        async confirm(display) {
          state.linked = true;
          return "APPROVE " + JSON.parse(display).fingerprint;
        },
      },
      "KAN-28",
    ),
    /EXISTING_LINK_OR_COVERAGE/,
  );
  assert.equal(state.posts, 0);
});

test("concurrent KAN-28 approval sends one POST and lost response reconciles by reads", async (t) => {
  const { state, journal, ports } = await fixture(t, "KAN-28");
  state.lost = true;
  let count = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    runRestLink(
      journal,
      {
        ...ports,
        async confirm(display) {
          if (++count === 2) release();
          await barrier;
          return "APPROVE " + JSON.parse(display).fingerprint;
        },
      },
      "KAN-28",
    );
  const results = await Promise.allSettled([start(), start()]);
  assert.ok(
    results.some(
      (r) =>
        r.status === "fulfilled" &&
        r.value.status === "UNCERTAIN_RUN_RECONCILE_LINK",
    ),
  );
  assert.equal(state.posts, 1);
  assert.equal(
    (await runRestLink(journal, ports, "KAN-28")).status,
    "RECONCILIATION_REQUIRED",
  );
  state.covered = true;
  assert.deepEqual(await runRestLink(journal, ports, "KAN-28"), {
    status: "RECONCILED",
    linkId: "10500",
  });
  assert.equal(state.posts, 1);
});

test("rejects the former fingerprint and refuses reversed existing links", async (t) => {
  const { state, journal, ports } = await fixture(t);
  await assert.rejects(
    runRestLink(journal, {
      ...ports,
      async confirm(display) {
        return "APPROVE " + JSON.parse(display).previousReviewFingerprint;
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  state.linked = state.reverse = true;
  await assert.rejects(
    runRestLink(journal, ports),
    /EXISTING_LINK_OR_COVERAGE/,
  );
  assert.equal(state.posts, 0);
});

test("lost response blocks a new dispatch until Jira direction and coverage are verified", async (t) => {
  const { state, journal, ports } = await fixture(t);
  state.lost = true;
  const result = await runRestLink(journal, {
    ...ports,
    async confirm(display) {
      return "APPROVE " + JSON.parse(display).fingerprint;
    },
  });
  assert.equal(result.status, "UNCERTAIN_RUN_RECONCILE_LINK");
  assert.equal(
    (await runRestLink(journal, ports)).status,
    "RECONCILIATION_REQUIRED",
  );
  state.covered = true;
  assert.deepEqual(await runRestLink(journal, ports), {
    status: "RECONCILED",
    linkId: "10500",
  });
  assert.equal(state.posts, 1);
});

test("concurrent approvals can persist at most one attempt", async (t) => {
  const { state, journal, ports } = await fixture(t);
  let count = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    runRestLink(journal, {
      ...ports,
      async confirm(display) {
        if (++count === 2) release();
        await barrier;
        return "APPROVE " + JSON.parse(display).fingerprint;
      },
    });
  await Promise.allSettled([start(), start()]);
  assert.equal(state.posts, 1);
  assert.equal(
    (await journal.latestEntries()).filter(
      (entry) => entry.operation === "jira.test.link",
    ).length,
    1,
  );
});
