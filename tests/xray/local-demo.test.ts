import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { XrayTokenProvider } from "../../tools/xray/clients/authentication.js";
import { runLocalDemoOffline as runLocalDemo } from "../../tools/xray/local-demo.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";

import { createDemoEvidenceFixture } from "./support/local-demo-evidence.js";

const evidenceRoot = await createDemoEvidenceFixture();

const remote = {
  issueId: "123",
  jira: { key: "KAN-123" },
  testType: { name: "Generic" },
  unstructured:
    "agentic-demo-website:playwright:task-create-inflight-single-submit-v1",
};
const approve = (preview: string) =>
  "APPROVE " + JSON.parse(preview).fingerprint;

test("missing registered local evidence stops before approval or dispatch", async (t) => {
  const { directory, journal, state, ports } = await fixture(t);
  await assert.rejects(
    runLocalDemo(directory, journal, {
      ...ports,
      async confirm() {
        assert.fail("missing evidence must suppress approval");
      },
    }),
    { code: "ENOENT" },
  );
  assert.equal(state.mutations, 0);
  assert.deepEqual(await journal.latestEntries(), []);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "xray-local-demo-"));
  const journal = new OperationJournal(directory);
  let closed = false;
  const close = async () => {
    if (closed) return;
    await journal.close();
    closed = true;
  };
  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  const state = { mutations: 0, lost: false, visible: false };
  const fetcher: typeof fetch = async (url, options) => {
    assert.match(
      String(url),
      /^https:\/\/xray\.cloud\.getxray\.app\/api\/v2\/(authenticate|graphql)$/,
    );
    if (String(url).endsWith("/authenticate")) {
      const claims = Buffer.from(
        JSON.stringify({ exp: Date.now() / 1000 + 3600 }),
      ).toString("base64url");
      return Response.json("mock." + claims + ".signature");
    }
    const { query } = JSON.parse(String(options?.body));
    if (query.startsWith("mutation ProposedGenericTest")) {
      assert.equal((await journal.latestEntries())[0]?.status, "Attempted");
      state.mutations++;
      state.visible = true;
      if (state.lost) throw new Error("mock lost response");
      return Response.json({ data: { createTest: { test: remote } } });
    }
    if (query.startsWith("query ReadTest("))
      return Response.json({ data: { getTest: remote } });
    assert.match(query, /^query ReadTests/);
    const results = state.visible ? [remote] : [];
    return Response.json({
      data: {
        getTests: { total: results.length, start: 0, limit: 50, results },
      },
    });
  };
  const tokens = new XrayTokenProvider({
    apiBase: "https://xray.cloud.getxray.app",
    fetch: fetcher,
    credentials: {
      async resolve() {
        return { clientId: "mock-id", clientSecret: "mock-secret" };
      },
    },
  });
  return {
    close,
    directory,
    journal,
    state,
    ports: {
      tokens,
      fetch: fetcher,
      async confirm(preview: string) {
        return approve(preview);
      },
    },
  };
}

test("wrong and expired confirmations never reserve or dispatch", async (t) => {
  const { journal, state, ports } = await fixture(t);
  await assert.rejects(
    runLocalDemo(evidenceRoot, journal, {
      ...ports,
      async confirm() {
        return "APPROVE wrong";
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  let time = Date.now();
  await assert.rejects(
    runLocalDemo(evidenceRoot, journal, {
      ...ports,
      now: () => time,
      async confirm(preview) {
        time += 120_000;
        return approve(preview);
      },
    }),
    /LOCAL_APPROVAL_DENIED_OR_EXPIRED/,
  );
  assert.equal(state.mutations, 0);
  assert.deepEqual(await journal.latestEntries(), []);
});

test("concurrent approvals dispatch once and persist verified readback", async (t) => {
  const { journal, state, ports } = await fixture(t);
  let displayed = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = () =>
    runLocalDemo(evidenceRoot, journal, {
      ...ports,
      async confirm(preview) {
        if (++displayed === 2) release();
        await barrier;
        return approve(preview);
      },
    });
  const results = await Promise.allSettled([start(), start()]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(state.mutations, 1);
  const [entry] = await journal.latestEntries();
  assert.equal(entry?.status, "Confirmed");
  assert.deepEqual(entry?.remoteIds, ["123"]);
  assert.equal(entry?.remoteTestKey, "KAN-123");
});

test("lost response remains reserved and a reopened journal reconciles using reads", async (t) => {
  const { directory, journal, state, ports, close } = await fixture(t);
  state.lost = true;
  assert.equal(
    (await runLocalDemo(evidenceRoot, journal, ports)).status,
    "UNCERTAIN_RUN_RECONCILE",
  );
  await close();
  const reopened = new OperationJournal(directory);
  try {
    state.visible = false;
    const readOnly = {
      ...ports,
      async confirm(): Promise<never> {
        throw new Error("unexpected prompt");
      },
    };
    assert.equal(
      (await runLocalDemo(evidenceRoot, reopened, readOnly)).status,
      "EXISTING_ATTEMPT_REVIEW_REQUIRED",
    );
    state.visible = true;
    assert.equal(
      (await runLocalDemo(evidenceRoot, reopened, readOnly)).status,
      "RECONCILED",
    );
    assert.equal(state.mutations, 1);
  } finally {
    await reopened.close();
  }
});

test("an existing remote identity blocks the prompt and dispatch", async (t) => {
  const { journal, state, ports } = await fixture(t);
  state.visible = true;
  await assert.rejects(
    runLocalDemo(evidenceRoot, journal, {
      ...ports,
      async confirm() {
        assert.fail("duplicate must suppress the prompt");
      },
    }),
    /Ambiguous duplicate/,
  );
  assert.equal(state.mutations, 0);
  assert.deepEqual(await journal.latestEntries(), []);
});
