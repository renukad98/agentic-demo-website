import test from "node:test";
import assert from "node:assert/strict";
import {
  XrayTokenProvider,
  ReferencedCredentialProvider,
  type CredentialProvider,
  type TokenProvider,
} from "../../tools/xray/clients/authentication.js";
import {
  approvedApiBase,
  apiRegions,
  type HttpFetch,
  type Diagnostic,
  XrayReadError,
  postJson,
} from "../../tools/xray/clients/http.js";
import { XrayHttpReadTransport } from "../../tools/xray/clients/transport.js";
import { readOperations } from "../../tools/xray/clients/operations.js";
import {
  XrayReadClient,
  DisabledWriteTransport,
} from "../../tools/xray/clients/index.js";
import { Publisher } from "../../tools/xray/publisher.js";
import { genericProposal } from "../../tools/xray/planner.js";
import { fingerprint } from "../../tools/agentic/artifacts.js";
import { boundFixture, mockCreation } from "./publication-fixtures.js";

const base = apiRegions.global;
const now = 1800000000000;
function token(expires = now + 300000) {
  return `${Buffer.from('{"alg":"synthetic"}').toString("base64url")}.${Buffer.from(JSON.stringify({ exp: expires / 1000 })).toString("base64url")}.synthetic-signature`;
}
const credentials: CredentialProvider = {
  async resolve() {
    return { clientId: "synthetic-id", clientSecret: "synthetic-secret" };
  },
};
function json(
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
function mockFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): HttpFetch {
  return async (input, init) => handler(String(input), init ?? {});
}
const staticTokens: TokenProvider = {
  async getToken() {
    return token();
  },
  invalidate() {},
};
const testDefinition = {
  issueId: "51",
  testType: { name: "Generic" },
  unstructured: "demo:node:stable",
  jira: { key: "SYN-51", summary: "Synthetic" },
};
function readTransport(
  fetcher: HttpFetch,
  extra: Partial<ConstructorParameters<typeof XrayHttpReadTransport>[0]> = {},
) {
  return new XrayHttpReadTransport({
    apiBase: base,
    tokens: staticTokens,
    fetch: fetcher,
    retries: 0,
    ...extra,
  });
}
function readTest(transport: XrayHttpReadTransport) {
  return transport.request(readOperations.test.query, { id: "51" });
}

const executionSnapshot = {
  issueId: "10067",
  projectId: "10001",
  testEnvironments: ["chromium"],
  jira: {
    key: "KAN-27",
    summary: "Automated validation for KAN-25",
    created: "2026-11-18T09:53:48.863+0530",
  },
  tests: { total: 1, start: 0, results: [{ issueId: "10066" }] },
};

test("read transport returns the observed execution snapshot to the client", async () => {
  const client = new XrayReadClient(
    readTransport(
      mockFetch((_, init) => {
        assert.deepEqual(JSON.parse(String(init.body)), {
          query: readOperations.executionSnapshot.query,
          variables: { id: "10067" },
        });
        return json({ data: { getTestExecution: executionSnapshot } });
      }),
    ),
  );
  assert.deepEqual(
    await client.getExecutionSnapshot("10067"),
    executionSnapshot,
  );
});

test("read transport rejects malformed execution snapshots and mismatched issue IDs", async () => {
  for (const snapshot of [
    { ...executionSnapshot, testEnvironments: "chromium" },
    { ...executionSnapshot, tests: { total: 1, start: 0, results: [] } },
    { ...executionSnapshot, issueId: "10068" },
  ]) {
    const transport = readTransport(
      mockFetch(() => json({ data: { getTestExecution: snapshot } })),
    );
    await assert.rejects(
      transport.request(readOperations.executionSnapshot.query, {
        id: "10067",
      }),
      /MALFORMED_RESPONSE/,
    );
  }
});

test("approved external reference resolves independently and fails closed on missing or invalid credentials", async () => {
  const calls: string[] = [];
  const provider = new ReferencedCredentialProvider(
    "approved/synthetic-reference",
    {
      async resolveApprovedReference(reference, audience) {
        calls.push(reference, audience);
        return credentials.resolve(audience);
      },
    },
  );
  assert.equal((await provider.resolve(base)).clientId, "synthetic-id");
  assert.deepEqual(calls, ["approved/synthetic-reference", base]);
  const missing = new ReferencedCredentialProvider("missing", {
    async resolveApprovedReference() {
      throw new Error("synthetic secret in external error");
    },
  });
  await assert.rejects(
    missing.resolve(base),
    (error: unknown) =>
      error instanceof XrayReadError &&
      error.code === "CREDENTIALS_UNAVAILABLE" &&
      !error.message.includes("secret"),
  );
  const invalid = new ReferencedCredentialProvider("invalid", {
    async resolveApprovedReference() {
      return { clientId: "", clientSecret: "" };
    },
  });
  await assert.rejects(invalid.resolve(base), /INVALID_CREDENTIALS/);
});
test("missing credentials prevent authentication HTTP calls", async () => {
  let calls = 0;
  const provider = new XrayTokenProvider({
    apiBase: base,
    fetch: mockFetch(() => {
      calls++;
      return json(token());
    }),
  });
  await assert.rejects(provider.getToken(base), /CREDENTIALS_UNAVAILABLE/);
  assert.equal(calls, 0);
});
test("authentication uses documented endpoint and reuses one in-memory token for concurrent requests", async () => {
  let calls = 0;
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    now: () => now,
    fetch: mockFetch((url, init) => {
      calls++;
      assert.equal(url, `${base}/api/v2/authenticate`);
      assert.equal(init.redirect, "error");
      assert.deepEqual(JSON.parse(String(init.body)), {
        client_id: "synthetic-id",
        client_secret: "synthetic-secret",
      });
      assert.equal(new Headers(init.headers).has("authorization"), false);
      return json(token());
    }),
  });
  const values = await Promise.all([
    provider.getToken(base),
    provider.getToken(base),
  ]);
  assert.equal(values[0], values[1]);
  await provider.getToken(base);
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(provider).includes(token()), false);
});
test("token expiry refreshes before expiration; a token is never used for another region", async () => {
  let clock = now;
  let calls = 0;
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    now: () => clock,
    fetch: mockFetch(() => {
      calls++;
      return json(token(clock + 300000));
    }),
  });
  await provider.getToken(base);
  clock += 240001;
  await provider.getToken(base);
  assert.equal(calls, 2);
  await assert.rejects(provider.getToken(apiRegions.eu), /INVALID_ENDPOINT/);
});
for (const status of [400, 401, 403, 500]) {
  test(`authentication HTTP ${status} fails without exposing response body`, async () => {
    const provider = new XrayTokenProvider({
      apiBase: base,
      credentials,
      fetch: mockFetch(() => json({ sensitive: "synthetic-secret" }, status)),
    });
    await assert.rejects(
      provider.getToken(base),
      (error: unknown) =>
        error instanceof XrayReadError &&
        error.status === status &&
        !JSON.stringify(error).includes("synthetic-secret"),
    );
  });
}
test("malformed, expired, non-token and wrong-content-type authentication responses are rejected", async () => {
  for (const value of [
    { token: token() },
    "not-a-token",
    token(now - 1),
    "a.%%%%.b",
  ]) {
    const provider = new XrayTokenProvider({
      apiBase: base,
      credentials,
      now: () => now,
      fetch: mockFetch(() => json(value)),
    });
    await assert.rejects(provider.getToken(base), /INVALID_TOKEN/);
  }
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    fetch: mockFetch(
      () =>
        new Response("sensitive", {
          headers: { "content-type": "text/plain" },
        }),
    ),
  });
  await assert.rejects(provider.getToken(base), /MALFORMED_RESPONSE/);
});
for (const host of Object.values(apiRegions))
  test(`approved API region: ${new URL(host).hostname}`, () => {
    assert.equal(approvedApiBase(host), host);
  });
for (const host of [
  "http://xray.cloud.getxray.app",
  "https://evil.example",
  "https://xray.cloud.getxray.app.evil.example",
  "https://user:synthetic@xray.cloud.getxray.app",
  `${base}/api`,
  `${base}?token=synthetic`,
  `${base}#fragment`,
  "https://xray.cloud.getxray.app:8443",
  "https://127.0.0.1",
]) {
  test(`unapproved endpoint is rejected without credentials/network: ${host.split("?")[0]}`, () => {
    assert.throws(() => approvedApiBase(host), /INVALID_ENDPOINT/);
    assert.throws(
      () => new XrayTokenProvider({ apiBase: host }),
      /INVALID_ENDPOINT/,
    );
    assert.throws(
      () => new XrayHttpReadTransport({ apiBase: host, tokens: staticTokens }),
      /INVALID_ENDPOINT/,
    );
  });
}
test("safe read has a correlation ID, bearer header and no redirects or cookie credentials", async () => {
  const events: Diagnostic[] = [];
  const client = new XrayReadClient(
    readTransport(
      mockFetch((url, init) => {
        assert.equal(url, `${base}/api/v2/graphql`);
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(init.credentials, "omit");
        assert.equal(
          new Headers(init.headers).get("authorization"),
          `Bearer ${token()}`,
        );
        assert.match(
          new Headers(init.headers).get("x-request-id")!,
          /^[0-9a-f-]{36}$/,
        );
        return json({ data: { getTest: testDefinition } });
      }),
      { diagnostics: (event) => events.push(event) },
    ),
  );
  assert.equal((await client.getTest("51"))?.testType.name, "Generic");
  assert.equal(events[0]?.operation, "test");
  assert.equal(events[0]?.outcome, "success");
});
test("mutation, alias, batch, introspection, extra field and unknown query forms never resolve tokens or send HTTP", async () => {
  let calls = 0;
  const transport = readTransport(
    mockFetch(() => {
      calls++;
      return json({});
    }),
    {
      tokens: {
        async getToken() {
          calls++;
          return token();
        },
        invalidate() {},
      },
    },
  );
  for (const query of [
    'mutation { deleteTest(issueId:"51") }',
    "query { anything }",
    "query { __schema { types { name } } }",
    'query { alias:getTest(issueId:"51"){issueId} }',
    `[${readOperations.test.query}]`,
    `${readOperations.test.query} mutation {x}`,
    readOperations.test.query.replace(
      "issueId testType",
      "issueId secret testType",
    ),
  ])
    await assert.rejects(
      transport.request(query, { id: "51" }),
      /UNSUPPORTED_OPERATION/,
    );
  await assert.rejects(
    transport.request(readOperations.test.query, {
      id: "51",
      unknown: "field",
    }),
    /INVALID_INPUT/,
  );
  assert.equal(calls, 0);
});
test("invalid identifiers and JQL injection reject before network", async () => {
  const client = new XrayReadClient(
    readTransport(
      mockFetch(() => {
        throw new Error("must not call");
      }),
    ),
  );
  for (const id of ["", "0", "-1", "SYN-1", "1 OR 1", "../1"])
    await assert.rejects(client.getTest(id), /INVALID_INPUT/);
  for (const key of ["SYN-1 OR project=OTHER", "../SYN-1", "syn-1"])
    await assert.rejects(client.getTestByKey(key), /INVALID_INPUT/);
  await assert.rejects(
    client.searchTests('SYN" OR project = "OTHER'),
    /INVALID_INPUT/,
  );
});
test("HTTP timeout is bounded even if a mock ignores AbortSignal", async () => {
  const transport = readTransport(
    mockFetch(() => new Promise<Response>(() => undefined)),
    { timeoutMs: 5 },
  );
  await assert.rejects(readTest(transport), /TIMEOUT/);
});
test("authentication timeout and response-body timeout are bounded", async () => {
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    timeoutMs: 5,
    fetch: mockFetch(() => new Promise<Response>(() => undefined)),
  });
  await assert.rejects(provider.getToken(base), /TIMEOUT/);
  const transport = readTransport(
    mockFetch(
      () =>
        new Response(new ReadableStream({ start() {} }), {
          headers: { "content-type": "application/json" },
        }),
    ),
    { timeoutMs: 5 },
  );
  await assert.rejects(readTest(transport), /TIMEOUT/);
});
test("safe-read transient retries are bounded and reuse the request correlation ID", async () => {
  let calls = 0;
  const ids: string[] = [];
  const transport = readTransport(
    mockFetch((_url, init) => {
      ids.push(new Headers(init.headers).get("x-request-id")!);
      calls++;
      return calls === 1
        ? json({}, 503)
        : json({ data: { getTest: testDefinition } });
    }),
    { retries: 1 },
  );
  await readTest(transport);
  assert.equal(calls, 2);
  assert.equal(new Set(ids).size, 1);
  calls = 0;
  const failing = readTransport(
    mockFetch(() => {
      calls++;
      throw new Error("synthetic transport sensitive body");
    }),
    { retries: 2 },
  );
  await assert.rejects(readTest(failing), /NETWORK/);
  assert.equal(calls, 3);
});
test("unauthorized read refreshes once; repeated 401 and 403/429 are not retried indefinitely", async () => {
  let invalidations = 0;
  let calls = 0;
  const provider = {
    async getToken() {
      return token();
    },
    invalidate() {
      invalidations++;
    },
  };
  const transport = readTransport(
    mockFetch(() => {
      calls++;
      return json({}, 401);
    }),
    { tokens: provider, retries: 2 },
  );
  await assert.rejects(readTest(transport), /UNAUTHORIZED/);
  assert.equal(calls, 2);
  assert.equal(invalidations, 1);
  for (const status of [403, 429]) {
    calls = 0;
    await assert.rejects(
      readTest(
        readTransport(
          mockFetch(() => {
            calls++;
            return json({}, status);
          }),
          { retries: 2 },
        ),
      ),
      /HTTP/,
    );
    assert.equal(calls, 1);
  }
});
test("redirects never resend credentials or authorization to another host", async () => {
  let calls = 0;
  const fetcher = mockFetch((_url, init) => {
    calls++;
    assert.equal(init.redirect, "error");
    return new Response(null, {
      status: 302,
      headers: { location: "https://evil.example" },
    });
  });
  await assert.rejects(readTest(readTransport(fetcher)), /REDIRECT/);
  assert.equal(calls, 1);
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    fetch: fetcher,
  });
  await assert.rejects(provider.getToken(base), /REDIRECT/);
  assert.equal(calls, 2);
});
test("GraphQL errors reject partial data without logging server messages", async () => {
  const events: Diagnostic[] = [];
  const transport = readTransport(
    mockFetch(() =>
      json({
        errors: [
          { message: "synthetic-secret", extensions: { token: token() } },
        ],
        data: { getTest: testDefinition },
      }),
    ),
    { diagnostics: (e) => events.push(e) },
  );
  await assert.rejects(readTest(transport), /GRAPHQL/);
  assert.equal(JSON.stringify(events).includes("synthetic-secret"), false);
  assert.equal(JSON.stringify(events).includes(token()), false);
});
test("malformed JSON, oversized bodies and malformed GraphQL models are rejected", async () => {
  for (const response of [
    () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    () => json({}),
    () => json({ errors: "invalid", data: { getTest: null } }),
    () => json({ data: { getTest: { issueId: "not-id" } } }),
    () => json({ data: [] }),
    () =>
      json({ data: { getTest: null } }, 200, { "content-length": "2000000" }),
  ])
    await assert.rejects(
      readTest(readTransport(mockFetch(response))),
      /MALFORMED_RESPONSE|RESPONSE_TOO_LARGE/,
    );
});
test("paginated Tests terminate, resolve by key, and never cache one Story's coverage in another", async () => {
  const client = new XrayReadClient(
    readTransport(
      mockFetch((_url, init) => {
        const { query, variables } = JSON.parse(String(init.body));
        if (
          query === readOperations.tests.query &&
          variables.jql.startsWith("key")
        )
          return json({
            data: {
              getTests: {
                total: 1,
                start: 0,
                limit: 2,
                results: [testDefinition],
              },
            },
          });
        if (query === readOperations.coverage.query)
          return json({
            data: {
              getTest: {
                issueId: variables.id,
                coverableIssues: {
                  total: 1,
                  start: 0,
                  limit: variables.limit,
                  results: [
                    {
                      issueId: variables.id === "51" ? "101" : "202",
                      jira: {
                        key: variables.id === "51" ? "SYN-101" : "SYN-202",
                      },
                    },
                  ],
                },
              },
            },
          });
        return json({
          data: {
            getTests: {
              total: 2,
              start: variables.start,
              limit: variables.limit,
              results: [
                {
                  ...testDefinition,
                  issueId: String(51 + variables.start),
                  jira: { key: `SYN-${51 + variables.start}` },
                },
              ],
            },
          },
        });
      }),
    ),
  );
  assert.equal((await client.searchTests("SYN", { pageSize: 1 })).length, 2);
  assert.equal((await client.getTestByKey("SYN-51"))?.issueId, "51");
  const [a, b] = await Promise.all([
    client.getCoverage("51"),
    client.getCoverage("52"),
  ]);
  assert.equal(a[0]?.jira.key, "SYN-101");
  assert.equal(b[0]?.jira.key, "SYN-202");
});
test("pagination detects limits, repeated records, wrong offsets, empty progress and changing totals", async () => {
  for (const variant of [
    "maxPages",
    "maxItems",
    "duplicate",
    "offset",
    "empty",
    "changing",
  ]) {
    const client = new XrayReadClient(
      readTransport(
        mockFetch((_url, init) => {
          const { variables } = JSON.parse(String(init.body));
          const start = variables.start;
          return json({
            data: {
              getTests: {
                total: variant === "changing" && start ? 3 : 2,
                start: variant === "offset" ? 5 : start,
                limit: variables.limit,
                results:
                  variant === "empty"
                    ? []
                    : [
                        {
                          ...testDefinition,
                          issueId: String(
                            51 + (variant === "duplicate" ? 0 : start),
                          ),
                        },
                      ],
              },
            },
          });
        }),
      ),
    );
    await assert.rejects(
      client.searchTests("SYN", {
        pageSize: 1,
        maxPages: variant === "maxPages" ? 1 : 5,
        maxItems: variant === "maxItems" ? 1 : 10,
      }),
      /PAGINATION/,
    );
  }
});
test("existing execution and Test Run reads are allowlisted and paginated", async () => {
  const client = new XrayReadClient(
    readTransport(
      mockFetch((_url, init) => {
        const { query, variables } = JSON.parse(String(init.body));
        if (query === readOperations.execution.query)
          return json({
            data: {
              getTestExecution: { issueId: "90", jira: { key: "SYN-90" } },
            },
          });
        if (query === readOperations.executions.query)
          return json({
            data: {
              getTestExecutions: {
                total: 1,
                start: 0,
                limit: variables.limit,
                results: [{ issueId: "90", jira: { key: "SYN-90" } }],
              },
            },
          });
        return json({
          data: {
            getTestRuns: {
              total: 1,
              start: 0,
              limit: variables.limit,
              results: [
                {
                  id: "run-1",
                  status: { name: "PASSED" },
                  evidence: [{ filename: "result.txt" }],
                  test: { issueId: "51" },
                  testExecution: { issueId: "90" },
                },
              ],
            },
          },
        });
      }),
    ),
  );
  assert.equal((await client.getTestExecution("90"))?.jira.key, "SYN-90");
  assert.equal((await client.searchExecutions("SYN")).length, 1);
  assert.equal((await client.getAllRuns("90"))[0]?.status.name, "PASSED");
});
test("authentication/transport diagnostics and serialization exclude credentials and tokens; no filesystem dependency", async () => {
  const events: Diagnostic[] = [];
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    now: () => now,
    diagnostics: (e) => events.push(e),
    fetch: mockFetch(() => json(token())),
  });
  const transport = readTransport(
    mockFetch(() => json({ data: { getTest: testDefinition } })),
    { tokens: provider, diagnostics: (e) => events.push(e) },
  );
  await readTest(transport);
  const serialized = JSON.stringify({ provider, transport, events });
  for (const secret of [
    "synthetic-secret",
    "synthetic-id",
    token(),
    "authorization",
  ])
    assert.equal(serialized.includes(secret), false);
  assert.equal(events.length, 2);
});
test("publication stays disabled after successful mock authentication and read", async () => {
  const client = new XrayReadClient(
    readTransport(mockFetch(() => json({ data: { getTest: testDefinition } }))),
  );
  assert.equal((await client.getTest("51"))?.issueId, "51");
  const digest = fingerprint("synthetic");
  const proposal = genericProposal(
    "SYN-1",
    "SYN",
    boundFixture({
      schemaVersion: "1.0.0",
      repository: "demo",
      runner: "node",
      automationId: "stable",
      sourceLocation: "synthetic.test.ts",
      behaviorDigest: digest,
      sourceDigest: digest,
      associations: [
        {
          storyKey: "SYN-1",
          scenarioIds: ["C1"],
          requirementIds: ["R1"],
          acceptanceIds: ["A1"],
        },
      ],
    }),
    "Synthetic",
    mockCreation,
  );
  await assert.rejects(new Publisher().publish(proposal), /disabled/);
  await assert.rejects(
    new DisabledWriteTransport().write("xray.results.import", {}),
    /disabled/,
  );
});

test("the network primitive also blocks mutations and non-allowlisted endpoints at runtime", async () => {
  let calls = 0;
  const fetcher = mockFetch(() => {
    calls++;
    return json({});
  });
  await assert.rejects(
    postJson(
      fetcher,
      base,
      "/api/v2/graphql",
      { query: 'mutation { deleteTest(issueId:"51") }', variables: {} },
      100,
      "synthetic",
    ),
    /UNSUPPORTED_OPERATION/,
  );
  await assert.rejects(
    postJson(
      fetcher,
      base,
      "/api/v2/import/execution" as "/api/v2/graphql",
      {},
      100,
      "synthetic",
    ),
    /UNSUPPORTED_OPERATION/,
  );
  assert.equal(calls, 0);
  assert.equal(Object.isFrozen(readOperations), true);
});

test("credential and token providers cannot make requests wait indefinitely", async () => {
  const provider = new XrayTokenProvider({
    apiBase: base,
    timeoutMs: 5,
    credentials: { resolve: () => new Promise(() => undefined) },
  });
  await assert.rejects(provider.getToken(base), /TIMEOUT/);
  const transport = readTransport(
    mockFetch(() => {
      throw new Error("must not call");
    }),
    {
      timeoutMs: 5,
      tokens: { getToken: () => new Promise(() => undefined), invalidate() {} },
    },
  );
  await assert.rejects(readTest(transport), /TIMEOUT/);
});

test("a rejected token is refreshed once and the second read can succeed", async () => {
  let authCalls = 0;
  let readCalls = 0;
  const provider = new XrayTokenProvider({
    apiBase: base,
    credentials,
    now: () => now,
    fetch: mockFetch(() => {
      authCalls++;
      return json(token(now + authCalls * 300000));
    }),
  });
  const transport = readTransport(
    mockFetch(() => {
      readCalls++;
      return readCalls === 1
        ? json({}, 401)
        : json({ data: { getTest: testDefinition } });
    }),
    { tokens: provider },
  );
  await readTest(transport);
  assert.equal(authCalls, 2);
  assert.equal(readCalls, 2);
});

test("response identity mismatches cannot leak another Test or execution context", async () => {
  await assert.rejects(
    readTest(
      readTransport(
        mockFetch(() =>
          json({ data: { getTest: { ...testDefinition, issueId: "52" } } }),
        ),
      ),
    ),
    /MALFORMED_RESPONSE/,
  );
  const client = new XrayReadClient(
    readTransport(
      mockFetch(() =>
        json({
          data: {
            getTestRuns: {
              total: 1,
              start: 0,
              limit: 100,
              results: [
                {
                  id: "run-other",
                  status: { name: "PASSED" },
                  test: { issueId: "51" },
                  testExecution: { issueId: "91" },
                },
              ],
            },
          },
        }),
      ),
    ),
  );
  await assert.rejects(client.getRuns("90"), /MALFORMED_RESPONSE/);
});
