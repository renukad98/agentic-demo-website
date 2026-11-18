import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  ProtectedAuthorityAdapter,
  ProtectedCredentialReference,
  protectedReadSession,
  type AuthenticatedApproverVerifier,
} from "../../tools/xray/protected-integration.js";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { objectDigest } from "../../tools/agentic/artifacts.js";
import { createProductionWriteExecutor } from "../../tools/xray/write-integration.js";
import { readOperations } from "../../tools/xray/clients/operations.js";
import { XrayHttpReadTransport } from "../../tools/xray/clients/transport.js";
import { fixtureNow, jsonFixture } from "./support/json-journal-fixtures.js";
import { SyntheticHumanAuthority } from "./support/human-authority-fixture.js";

const base = "https://xray.cloud.getxray.app";
let network = 0;
before(() => {
  const deny = () => {
    network++;
    throw new Error("NETWORK_FORBIDDEN");
  };
  mock.method(globalThis, "fetch", deny);
  mock.method(http, "request", deny);
  mock.method(https, "request", deny);
  mock.method(net.Socket.prototype, "connect", deny);
});
after(() => {
  assert.equal(network, 0);
  mock.restoreAll();
});

function syntheticSource() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async resolveApprovedReference(reference: string, audience: string) {
      calls++;
      assert.equal(reference, "synthetic-reference");
      assert.equal(audience, base);
      return {
        clientId: "synthetic-id-not-real",
        clientSecret: "synthetic-secret-not-real",
      };
    },
  };
}
test("protected reference: default offline resolves no references or network", async () => {
  const source = syntheticSource();
  const provider = new ProtectedCredentialReference({
    apiBase: base,
    reference: "synthetic-reference",
    source,
  });
  await assert.rejects(provider.resolve(base), /CREDENTIALS_UNAVAILABLE/);
  const session = protectedReadSession({
    apiBase: base,
    reference: "synthetic-reference",
    source,
  });
  await assert.rejects(
    session.client.getTestByKey("SYN-2"),
    /CREDENTIALS_UNAVAILABLE/,
  );
  session.close();
  assert.equal(source.calls, 0);
});
test("protected reference: explicit synthetic protected source resolves only configured host", async () => {
  const source = syntheticSource();
  const provider = new ProtectedCredentialReference({
    apiBase: base,
    reference: "synthetic-reference",
    source,
    mode: "protected-host",
  });
  assert.equal(
    (await provider.resolve(base)).clientId,
    "synthetic-id-not-real",
  );
  await assert.rejects(
    provider.resolve("https://eu.xray.cloud.getxray.app"),
    /INVALID_ENDPOINT/,
  );
  assert.equal(source.calls, 1);
  assert.equal(
    JSON.stringify(provider),
    '{"type":"ProtectedCredentialReference"}',
  );
});
for (const reference of [
  undefined,
  "",
  "../secret",
  "https://example.com",
  "invalid reference",
]) {
  test(
    "protected reference: missing or invalid reference " + String(reference),
    async () => {
      const source = syntheticSource();
      if (reference !== undefined)
        assert.throws(
          () =>
            new ProtectedCredentialReference({
              apiBase: base,
              reference,
              source,
              mode: "protected-host",
            }),
          /INVALID_INPUT/,
        );
      else
        await assert.rejects(
          new ProtectedCredentialReference({
            apiBase: base,
            source,
            mode: "protected-host",
          }).resolve(base),
          /CREDENTIALS_UNAVAILABLE/,
        );
      assert.equal(source.calls, 0);
    },
  );
}
test("protected reference: unresolved and malformed synthetic values have fixed errors", async () => {
  for (const source of [
    {
      async resolveApprovedReference() {
        throw new Error("synthetic-private-detail");
      },
    },
    {
      async resolveApprovedReference() {
        return { unexpected: "synthetic-private-detail" };
      },
    },
  ]) {
    const provider = new ProtectedCredentialReference({
      apiBase: base,
      reference: "synthetic-reference",
      source,
      mode: "protected-host",
    });
    await assert.rejects(
      provider.resolve(base),
      (error) =>
        error instanceof Error &&
        !error.message.includes("synthetic-private-detail") &&
        /CREDENTIALS/.test(error.message),
    );
  }
});
test("protected session: missing explicit fetch keeps credential resolution disabled", async () => {
  const source = syntheticSource();
  const session = protectedReadSession({
    apiBase: base,
    reference: "synthetic-reference",
    source,
    mode: "protected-host",
  });
  await assert.rejects(session.client.getTestByKey("SYN-2"));
  session.close();
  assert.equal(source.calls, 0);
});
test("protected session: reused authentication and read transport sanitize serialization and clear tokens", async () => {
  const source = syntheticSource();
  let auth = 0,
    reads = 0;
  const token =
    "synthetic." +
    Buffer.from(
      JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    ).toString("base64url") +
    ".synthetic";
  const session = protectedReadSession({
    apiBase: base,
    reference: "synthetic-reference",
    source,
    mode: "protected-host",
    fetch: async (url, init) => {
      assert.equal(init?.redirect, "error");
      assert.equal(init?.credentials, "omit");
      if (String(url) === base + "/api/v2/authenticate") {
        auth++;
        return Response.json(token);
      }
      assert.equal(String(url), base + "/api/v2/graphql");
      reads++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.query, readOperations.tests.query);
      return Response.json({
        data: {
          getTests: {
            total: 1,
            start: 0,
            limit: 2,
            results: [
              {
                issueId: "101",
                jira: { key: "SYN-2", summary: "Synthetic" },
                testType: { name: "Generic" },
                unstructured: "synthetic-automation",
              },
            ],
          },
        },
      });
    },
  });
  assert.equal((await session.client.getTestByKey("SYN-2"))!.issueId, "101");
  assert.equal(auth, 1);
  assert.equal(reads, 1);
  assert(!JSON.stringify(session).includes(token));
  assert(!JSON.stringify(session).includes("synthetic-secret"));
  session.close();
  session.close();
  await session.client.getTestByKey("SYN-2");
  assert.equal(auth, 2);
  session.close();
});
test("protected session: redirects rejected without retry or secret error detail", async () => {
  const source = syntheticSource();
  let requests = 0;
  const session = protectedReadSession({
    apiBase: base,
    reference: "synthetic-reference",
    source,
    mode: "protected-host",
    fetch: async () => {
      requests++;
      return new Response("synthetic-private-detail", {
        status: 302,
        headers: { location: "https://outside.invalid" },
      });
    },
  });
  await assert.rejects(session.client.getTestByKey("SYN-2"), /REDIRECT/);
  session.close();
  assert.equal(requests, 1);
});
test("protected composition: untrusted hosts rejected before source or fetch", () => {
  for (const apiBase of [
    "http://xray.cloud.getxray.app",
    "https://outside.invalid",
    base + "/evil",
    "https://xray.cloud.getxray.app.evil.invalid",
  ])
    assert.throws(() => protectedReadSession({ apiBase }));
});
test("protected composition: mutation rejected before token or transport; no retry path exists", async () => {
  let calls = 0;
  const transport = new XrayHttpReadTransport({
    apiBase: base,
    tokens: {
      async getToken() {
        calls++;
        return "synthetic";
      },
      invalidate() {
        calls++;
      },
    },
    fetch: async () => {
      calls++;
      throw new Error();
    },
    retries: 0,
  });
  await assert.rejects(
    transport.request("mutation { createTest { issueId } }", {}),
  );
  assert.equal(calls, 0);
  assert.throws(createProductionWriteExecutor, /PRODUCTION_WRITES_DISABLED/);
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(join(tmpdir(), "protected-integration-"));
  const data = jsonFixture(),
    source = new SyntheticHumanAuthority();
  source.grant("create", data.request);
  source.grant("link", data.linkRequest);
  const identities: AuthenticatedApproverVerifier = {
    async verifyAuthenticatedApprover(binding) {
      return {
        ...binding,
        authenticatedAt: new Date(fixtureNow - 1000).toISOString(),
        active: true,
      };
    },
  };
  const context = {
    authorityId: source.authorityId,
    tenant: data.request.tenant,
    projectKey: data.request.projectKey,
    executorPrincipal: data.request.executorPrincipal,
    authorityEpoch: data.request.authorityEpoch,
  };
  const make = () =>
    new ProtectedAuthorityAdapter(context, {
      source,
      identities,
      now: () => fixtureNow,
    });
  const journals: OperationJournal[] = [];
  const open = () => {
    const j = new OperationJournal(root, () => fixtureNow);
    journals.push(j);
    return j;
  };
  const journal = open(),
    adapter = make();
  const reserve = () =>
    adapter
      .boundary()
      .authorizeAndReserve(
        journal,
        "create",
        data.request,
        data.proposal.payload,
      );
  const snapshot = async () =>
    JSON.parse(
      await fs.readFile(join(root, "journal", "operations.json"), "utf8"),
    );
  t.after(async () => {
    for (const j of journals)
      try {
        await j.close();
      } catch {
        /* synthetic failure cleanup */
      }
    assert(root.startsWith(join(tmpdir(), "protected-integration-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    ...data,
    source,
    identities,
    context,
    make,
    open,
    journal,
    adapter,
    reserve,
    snapshot,
  };
}
test("protected authority: independent verifier required and no production provider fallback", async (t) => {
  const f = await fixture(t);
  for (const dependencies of [{}, { source: f.source }]) {
    const adapter = new ProtectedAuthorityAdapter(f.context, dependencies);
    await assert.rejects(
      adapter.verify("create", f.request, objectDigest(f.request)),
      /PROTECTED_AUTHORITY/,
    );
  }
  assert.equal(f.source.consumeCalls, 0);
});
test("protected authority: valid synthetic identity reserves durably and cannot link an unconfirmed Test", async (t) => {
  const f = await fixture(t);
  const result = await f.reserve();
  assert.equal(result.productionExecution, "BLOCKED");
  assert.deepEqual(
    (await f.snapshot()).consumptions[0].authority.events.map(
      (e: { state: string }) => e.state,
    ),
    ["pending", "consumed"],
  );
  await assert.rejects(f.reserve());
  assert.equal(f.source.consumeCalls, 1);
  await assert.rejects(
    f.adapter
      .boundary()
      .authorizeAndReserve(f.journal, "link", f.linkRequest, f.link.payload),
    /LINK_REQUIRES_CONFIRMED_TEST/,
  );
  assert.equal(f.source.consumeCalls, 1);
  assert(!JSON.stringify(await f.snapshot()).includes("synthetic-secret"));
});
for (const mode of [
  "unavailable",
  "expired",
  "revoked",
  "identity mismatch",
  "identity outage",
  "operation",
  "evidence",
  "payload",
  "tenant",
  "project",
  "story",
  "automation",
] as const) {
  test(
    "protected authority: reject " + mode + " without consumption",
    async (t) => {
      const f = await fixture(t),
        decision = f.source.decisions.get("create")!;
      if (mode === "unavailable") f.source.unavailable = true;
      else if (mode === "expired")
        decision.expiresAt = new Date(fixtureNow - 1).toISOString();
      else if (mode === "revoked") decision.decision = "revoked";
      else if (mode === "identity outage")
        f.identities.verifyAuthenticatedApprover = async () => {
          throw new Error("synthetic-private-detail");
        };
      else if (mode === "identity mismatch")
        f.identities.verifyAuthenticatedApprover = async (b) => ({
          ...b,
          subject: "different",
          authenticatedAt: new Date(fixtureNow - 1000).toISOString(),
          active: true,
        });
      else if (mode === "operation")
        decision.request.operation = "jira.test.link";
      else if (mode === "evidence")
        decision.request.evidenceDigest = objectDigest("other");
      else if (mode === "payload")
        decision.request.payloadDigest = objectDigest("other");
      else if (mode === "tenant") decision.request.tenant = "other";
      else if (mode === "project") decision.request.projectKey = "OTHER";
      else if (mode === "story") decision.request.target = "SYN-9";
      else decision.request.automationIdentity = "other";
      await assert.rejects(
        f.reserve(),
        (error) =>
          error instanceof Error &&
          !error.message.includes("synthetic-private-detail"),
      );
      assert.equal(f.source.consumeCalls, 0);
    },
  );
}
test("protected authority: rechecks revocation immediately before source consumption", async (t) => {
  const f = await fixture(t);
  await f.adapter.verify("create", f.request, objectDigest(f.request));
  f.source.decisions.get("create")!.decision = "revoked";
  await assert.rejects(
    f.adapter.consumeApproval("create", objectDigest(f.request), "reservation"),
  );
  assert.equal(f.source.consumeCalls, 0);
});
test("protected coordination: uncertain source outcome is durable and cannot reconsume after restart", async (t) => {
  const f = await fixture(t);
  f.source.consumeFailure = true;
  await assert.rejects(f.reserve(), /UNCERTAIN/);
  assert.equal(f.source.consumeCalls, 1);
  assert.equal(
    (await f.snapshot()).consumptions[0].authority.events.at(-1).state,
    "uncertain",
  );
  await assert.rejects(
    f.adapter.consumeApproval("create", objectDigest(f.request), "reservation"),
    /RECONCILIATION/,
  );
  await f.journal.close();
  const reopened = f.open();
  await assert.rejects(
    f
      .make()
      .boundary()
      .authorizeAndReserve(reopened, "create", f.request, f.proposal.payload),
  );
  assert.equal(f.source.consumeCalls, 1);
});
for (const failAt of [1, 2]) {
  test(
    "protected coordination: journal failure " +
      (failAt === 1 ? "before" : "after") +
      " consumption fails closed",
    async (t) => {
      const f = await fixture(t),
        rename = fs.rename;
      let calls = 0;
      const fault = mock.method(
        fs,
        "rename",
        async (...args: Parameters<typeof fs.rename>) => {
          if (++calls === failAt) throw new Error("synthetic-failure");
          await rename(...args);
        },
      );
      try {
        await assert.rejects(f.reserve());
      } finally {
        fault.mock.restore();
      }
      assert.equal(f.source.consumeCalls, failAt === 1 ? 0 : 1);
      if (failAt === 2) {
        assert.equal(
          (await f.snapshot()).consumptions[0].authority.events.at(-1).state,
          "pending",
        );
        await f.journal.close();
        await assert.rejects(
          f
            .make()
            .boundary()
            .authorizeAndReserve(
              f.open(),
              "create",
              f.request,
              f.proposal.payload,
            ),
        );
        assert.equal(f.source.consumeCalls, 1);
      }
    },
  );
}
test("protected authority: default administrative and audit operations unavailable, production writes disabled", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.revokeApproval(), /UNAVAILABLE/);
  await assert.rejects(f.adapter.readAudit(), /UNAVAILABLE/);
  await f.reserve();
  const entry = (await f.journal.entries(f.request.operationId)).at(-1)!;
  await assert.rejects(
    f.journal.record({ ...entry, status: "Attempted" }),
    /PRODUCTION_AUTHORITY_EXECUTION_DISABLED/,
  );
  assert.throws(createProductionWriteExecutor, /PRODUCTION_WRITES_DISABLED/);
});

for (const field of [
  "tenant",
  "projectKey",
  "executorPrincipal",
  "authorityEpoch",
] as const) {
  test(
    "protected authority: configured " + field + " cannot be substituted",
    async (t) => {
      const f = await fixture(t);
      const context = {
        ...f.context,
        [field]: field === "projectKey" ? "OTHER" : "other",
      };
      const adapter = new ProtectedAuthorityAdapter(context, {
        source: f.source,
        identities: f.identities,
        now: () => fixtureNow,
      });
      await assert.rejects(
        adapter
          .boundary()
          .authorizeAndReserve(
            f.journal,
            "create",
            f.request,
            f.proposal.payload,
          ),
      );
      assert.equal(f.source.consumeCalls, 0);
    },
  );
}
test("protected identity: inactive identity and attempted binding mutation fail closed", async (t) => {
  const f = await fixture(t);
  f.identities.verifyAuthenticatedApprover = async (binding) => ({
    ...binding,
    active: false,
    authenticatedAt: new Date(fixtureNow - 1000).toISOString(),
  });
  await assert.rejects(f.reserve());
  f.identities.verifyAuthenticatedApprover = async (binding) => {
    binding.subject = "substituted";
    return binding;
  };
  await assert.rejects(f.reserve());
  assert.equal(f.source.consumeCalls, 0);
});
test("protected coordination: durable reservation exists before single concurrent source consumption", async (t) => {
  const f = await fixture(t),
    consume = f.source.consumeApproval.bind(f.source);
  f.source.consumeApproval = async (...args: Parameters<typeof consume>) => {
    const document = await f.snapshot();
    assert.equal(document.consumptions[0].authority.events[0].state, "pending");
    assert.equal(document.consumptions[0].consumptionId, args[2]);
    return consume(...args);
  };
  const outcomes = await Promise.allSettled([f.reserve(), f.reserve()]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.source.consumeCalls, 1);
});
