import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { OperationJournal } from "../../tools/xray/operation-journal.js";
import { ApprovalEvidenceGate } from "../../tools/agentic/approvals.js";
import {
  objectDigest,
  within,
  noSymlinks,
} from "../../tools/agentic/artifacts.js";
import { Publisher } from "../../tools/xray/publisher.js";
import { createProductionWriteExecutor } from "../../tools/xray/write-integration.js";
import {
  jsonFixture,
  fixtureNow,
  syntheticGate,
} from "./support/json-journal-fixtures.js";

let networkAttempts = 0;
before(() => {
  const deny = () => {
    networkAttempts++;
    throw new Error("NETWORK_FORBIDDEN");
  };
  mock.method(globalThis, "fetch", deny);
  mock.method(http, "request", deny);
  mock.method(https, "request", deny);
  mock.method(net.Socket.prototype, "connect", deny);
});
after(() => {
  assert.equal(networkAttempts, 0);
  mock.restoreAll();
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.mkdtemp(join(tmpdir(), "agentic-json-journal-")),
    instances: OperationJournal[] = [];
  const open = (now = () => fixtureNow, journalRoot = root) => {
    const journal = new OperationJournal(journalRoot, now);
    instances.push(journal);
    return journal;
  };
  const journal = open(),
    data = jsonFixture(),
    path = join(root, "journal", "operations.json");
  t.after(async () => {
    for (const item of instances)
      try {
        await item.close();
      } catch {
        /* fixture may be corrupt or closed */
      }
    assert(root.startsWith(join(tmpdir(), "agentic-json-journal-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  const handle = (reference = "synthetic-approval") =>
    syntheticGate(data.request).verify(reference, data.request);
  const reserve = async () =>
    journal.consumeAndReserve(
      data.request,
      data.proposal.payload,
      await handle(),
    );
  return { root, path, journal, open, ...data, handle, reserve };
}
function child(root: string, mode: string) {
  const processChild = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      resolve("tests/xray/support/json-journal-worker.ts"),
      root,
      mode,
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { SystemRoot: process.env.SystemRoot, TSX_DISABLE_CACHE: "1" },
    },
  );
  let output = "",
    readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });
  processChild.stdout!.on("data", (chunk) => {
    output += String(chunk);
    if (output.includes("READY")) readyResolve();
  });
  const done = new Promise<string>((r, reject) => {
    const timer = setTimeout(() => {
      processChild.kill("SIGKILL");
      reject(new Error("WORKER_TIMEOUT"));
    }, 15000);
    processChild.once("error", () => {
      clearTimeout(timer);
      reject(new Error("WORKER_START_FAILED"));
    });
    processChild.once("close", () => {
      clearTimeout(timer);
      r(output.trim());
    });
  });
  return { child: processChild, ready, done };
}
test("json: one complete journal stores reservation and consumption together", async (t) => {
  const f = await fixture(t),
    result = await f.reserve();
  assert.equal(result.entry.status, "Approved");
  assert.equal(result.remoteVerified, false);
  const data = JSON.parse(await fs.readFile(f.path, "utf8"));
  assert.equal(data.schemaVersion, "2.0.0");
  assert.equal(data.entries.length, 3);
  assert.equal(data.consumptions.length, 1);
  assert.deepEqual((await fs.readdir(join(f.root, "journal"))).sort(), [
    "operations.json",
    "writer-lock",
  ]);
});
test("json: temp write is flushed before same-directory rename", async (t) => {
  const f = await fixture(t),
    events: string[] = [];
  const originalOpen = fs.open,
    originalRename = fs.rename;
  const openMock = mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof fs.open>) => {
      const file = await originalOpen(...args);
      if (String(args[0]).includes("operations.json.tmp-")) {
        const sync = file.sync.bind(file);
        mock.method(file, "sync", async () => {
          events.push("sync");
          await sync();
        });
      }
      return file;
    },
  );
  const renameMock = mock.method(
    fs,
    "rename",
    async (
      from: Parameters<typeof fs.rename>[0],
      to: Parameters<typeof fs.rename>[1],
    ) => {
      assert.equal(
        String(from).slice(0, String(from).lastIndexOf("operations.json")),
        String(to).slice(0, String(to).lastIndexOf("operations.json")),
      );
      events.push("rename");
      await originalRename(from, to);
    },
  );
  try {
    await f.reserve();
  } finally {
    openMock.mock.restore();
    renameMock.mock.restore();
  }
  assert.deepEqual(events, ["sync", "rename"]);
});
test("json: rename failure cannot consume a grant or replace existing history", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const before = await fs.readFile(f.path, "utf8");
  const last = (await f.journal.entries(f.request.operationId)).at(-1)!;
  const fault = mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("synthetic"), { code: "EACCES" });
  });
  try {
    await assert.rejects(
      f.journal.record({ ...last, status: "Attempted" }),
      /REPLACEMENT_UNCERTAIN/,
    );
  } finally {
    fault.mock.restore();
  }
  assert.equal(await fs.readFile(f.path, "utf8"), before);
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.status,
    "Approved",
  );
  assert.equal(
    (await fs.readdir(join(f.root, "journal"))).filter((x) =>
      x.includes(".tmp-"),
    ).length,
    0,
  );
});
test("json: failed reservation leaves no partial consumption and needs re-verification", async (t) => {
  const f = await fixture(t),
    handle = await f.handle();
  const fault = mock.method(fs, "rename", async () => {
    throw new Error("synthetic");
  });
  try {
    await assert.rejects(
      f.journal.consumeAndReserve(f.request, f.proposal.payload, handle),
    );
  } finally {
    fault.mock.restore();
  }
  await assert.rejects(fs.readFile(f.path), { code: "ENOENT" });
  await assert.rejects(
    f.journal.consumeAndReserve(f.request, f.proposal.payload, handle),
    /WRITE_UNCERTAIN/,
  );
  await assert.rejects(f.reserve(), /WRITE_UNCERTAIN/);
});
for (const scenario of ["retry", "exhausted", "temp-changed", "destination-changed", "committed", "lock-lost"] as const) {
  test("Windows rename EPERM: " + scenario, { skip: process.platform !== "win32" }, async (t) => {
    const f = await fixture(t);
    await f.reserve();
    const last = (await f.journal.entries(f.request.operationId)).at(-1)!;
    const original = fs.rename;
    const attempts: string[] = [];
    const fault = mock.method(fs, "rename", async (source: string, destination: string) => {
      attempts.push(source);
      if (scenario === "retry" && attempts.length === 2) return original(source, destination);
      if (scenario === "temp-changed") await fs.writeFile(source, "unexpected");
      if (scenario === "destination-changed") await fs.writeFile(destination, "unexpected");
      if (scenario === "committed") await original(source, destination);
      if (scenario === "lock-lost") await fs.unlink(join(f.root, "journal", "writer-lock", "owner"));
      throw Object.assign(new Error("fault injection"), { code: "EPERM" });
    });
    try {
      if (scenario === "retry") {
        await f.journal.record({ ...last, status: "Attempted" });
        assert.equal(attempts.length, 2);
        assert.equal(attempts[0], attempts[1]);
        assert.equal((await f.journal.entries(f.request.operationId)).at(-1)!.status, "Attempted");
      } else {
        await assert.rejects(
          f.journal.record({ ...last, status: "Attempted" }),
          /REPLACEMENT_UNCERTAIN_RECONCILE/,
        );
        assert.equal(attempts.length, scenario === "exhausted" ? 4 : 1);
        assert.equal(new Set(attempts).size, 1);
        await assert.rejects(f.journal.record({ ...last, status: "Attempted" }), /WRITE_UNCERTAIN_RECONCILE/);
      }
    } finally {
      fault.mock.restore();
    }
  });
}
test("json: corrupt/truncated content fails closed without overwrite", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await fs.writeFile(f.path, '{"schemaVersion":');
  await assert.rejects(f.journal.entries(f.request.operationId), /CORRUPT/);
  await assert.rejects(f.reserve(), /CORRUPT/);
  assert.equal(await fs.readFile(f.path, "utf8"), '{"schemaVersion":');
});
test("json: complete history validation detects invalid transitions", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const data = JSON.parse(await fs.readFile(f.path, "utf8"));
  data.entries[0].status = "Confirmed";
  await fs.writeFile(f.path, JSON.stringify(data));
  await assert.rejects(f.journal.latestEntries(), /CORRUPT/);
});
test("json: consumed approval/payload bindings are revalidated on load", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const data = JSON.parse(await fs.readFile(f.path, "utf8"));
  data.consumptions[0].request.tenant = "other";
  await fs.writeFile(f.path, JSON.stringify(data));
  await assert.rejects(f.journal.latestEntries(), /CORRUPT/);
});
test("queue: concurrent instances serialize independent updates without loss", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const other = f.open(),
    payload = { other: true },
    request = {
      ...f.request,
      operationId: "other-operation",
      automationIdentity: "synthetic:playwright:other",
      payloadDigest: objectDigest(payload),
    };
  const own = syntheticGate(request);
  const result = await Promise.allSettled([
    other.consumeAndReserve(
      request,
      payload,
      await own.verify("other-approval", request),
    ),
    f.journal.consumeAndReserve(
      f.request,
      f.proposal.payload,
      await f.handle("duplicate"),
    ),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await f.journal.latestEntries()).length, 2);
});
test("queue: concurrent duplicate operation has one winner", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.reserve(), f.reserve()]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    JSON.parse(await fs.readFile(f.path, "utf8")).consumptions.length,
    1,
  );
});
test("approval: JSON claims and default authority cannot authorize reservation", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new ApprovalEvidenceGate().verify("claim", f.request));
  await assert.rejects(
    f.journal.consumeAndReserve(f.request, f.proposal.payload, {
      decision: "approved",
    }),
    /UNVERIFIED/,
  );
});
test("approval: expired approval and missing handle denied", async (t) => {
  const f = await fixture(t);
  const expired = await syntheticGate(f.request, fixtureNow - 1).verify(
    "expired",
    f.request,
  );
  await assert.rejects(
    f.journal.consumeAndReserve(f.request, f.proposal.payload, expired),
    /EXPIRED/,
  );
  await assert.rejects(
    f.journal.consumeAndReserve(
      f.request,
      f.proposal.payload,
      null as unknown as object,
    ),
    /UNVERIFIED/,
  );
});
for (const field of [
  "tenant",
  "projectKey",
  "target",
  "automationIdentity",
  "sourceDigest",
  "evidenceDigest",
  "preflightDigest",
  "payloadDigest",
  "operationId",
  "executorPrincipal",
  "authorityEpoch",
] as const) {
  test("approval: changed " + field + " denied", async (t) => {
    const f = await fixture(t),
      request = structuredClone(f.request);
    if (field.endsWith("Digest")) request[field] = "sha256:" + "0".repeat(64);
    else if (field === "projectKey") request[field] = "OTHER";
    else if (field === "target") request[field] = "OTHER-1";
    else request[field] = "other";
    await assert.rejects(
      f.journal.consumeAndReserve(
        request,
        f.proposal.payload,
        await f.handle(),
      ),
    );
  });
}
test("approval: payload mismatch and creation/link grant substitution denied", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.journal.consumeAndReserve(f.request, { changed: true }, await f.handle()),
    /PAYLOAD/,
  );
  await assert.rejects(
    f.journal.consumeAndReserve(
      f.linkRequest,
      f.link.payload,
      await f.handle(),
    ),
    /UNVERIFIED/,
  );
  const linkHandle = await syntheticGate(f.linkRequest).verify(
    "link",
    f.linkRequest,
  );
  await assert.rejects(
    f.journal.consumeAndReserve(f.request, f.proposal.payload, linkHandle),
    /UNVERIFIED/,
  );
});
test("recovery: restart preserves grant replay protection and blocks old-session attempt", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  await f.journal.close();
  const reopened = f.open();
  const last = (await reopened.entries(f.request.operationId)).at(-1)!;
  await assert.rejects(
    reopened.consumeAndReserve(f.request, f.proposal.payload, await f.handle()),
    /REPLAY/,
  );
  await assert.rejects(
    reopened.record({ ...last, status: "Attempted" }),
    /PREVIOUS_SESSION/,
  );
});
test("recovery: confirmed remote IDs/key survive reopen and failed writes", async (t) => {
  const f = await fixture(t);
  const { entry } = await f.reserve();
  await f.journal.record({ ...entry, status: "Attempted" });
  await f.journal.record({
    ...entry,
    status: "Confirmed",
    remoteIds: ["101"],
    remoteTestKey: "SYN-2",
  });
  await f.journal.close();
  const journal = f.open();
  const last = (await journal.entries(f.request.operationId)).at(-1)!;
  assert.deepEqual(last.remoteIds, ["101"]);
  assert.equal(last.remoteTestKey, "SYN-2");
  await assert.rejects(
    journal.record({
      ...last,
      status: "Uncertain",
      remoteIds: ["999"],
      remoteTestKey: "SYN-99",
    }),
  );
  assert.deepEqual(
    (await journal.entries(f.request.operationId)).at(-1)!.remoteIds,
    ["101"],
  );
});
test("recovery: uncertain timeout requires read-only reconciliation and cannot retry", async (t) => {
  const f = await fixture(t),
    { entry } = await f.reserve();
  await f.journal.record({ ...entry, status: "Attempted" });
  await f.journal.record({
    ...entry,
    status: "Uncertain",
    errorCode: "TIMEOUT",
    remoteIds: ["101"],
    remoteTestKey: "SYN-2",
  });
  await f.journal.close();
  const journal = f.open();
  await assert.rejects(journal.assertNoUncertainOperations(), /blocked/);
  await assert.rejects(journal.record({ ...entry, status: "Attempted" }));
  await assert.rejects(
    journal.consumeAndReserve(
      f.request,
      f.proposal.payload,
      await f.handle("fresh-approval"),
    ),
  );
  const uncertain = (await journal.entries(entry.operationId)).at(-1)!;
  await assert.rejects(
    journal.record({
      ...uncertain,
      status: "Reconciled",
      reconciliation: "absent",
      reconciliationEvidenceDigest: f.request.evidenceDigest,
    }),
  );
  await journal.record({
    ...uncertain,
    status: "Reconciled",
    reconciliation: "confirmed",
    reconciliationEvidenceDigest: objectDigest({ syntheticReadBack: true }),
  });
  await journal.assertNoUncertainOperations();
});
test("ownership: independent writer denied while live owner is idle", async (t) => {
  const f = await fixture(t);
  await f.reserve();
  const result = await child(f.root, "reserve").done;
  assert.equal(result, "DENIED");
  assert.equal((await f.journal.latestEntries()).length, 1);
});
test("ownership: stale lock is never stolen or automatically deleted", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.root, "journal", "writer-lock"), { recursive: true });
  await assert.rejects(f.reserve(), /BUSY_OR_STALE/);
  assert.equal(
    (await fs.stat(join(f.root, "journal", "writer-lock"))).isDirectory(),
    true,
  );
});
test("recovery: interrupted writer leaves locked ownership and orphan temp without promotion", async (t) => {
  const f = await fixture(t),
    w = child(f.root, "interrupted");
  try {
    await Promise.race([
      w.ready,
      w.done.then(() => {
        throw new Error("NOT_READY");
      }),
    ]);
  } finally {
    w.child.kill("SIGKILL");
    await w.done;
  }
  const data = JSON.parse(await fs.readFile(f.path, "utf8"));
  assert.equal(data.entries.length, 3);
  assert.equal(
    (await f.journal.entries(f.request.operationId)).at(-1)!.status,
    "Approved",
  );
  await assert.rejects(f.reserve(), /BUSY_OR_STALE/);
  assert.equal(
    (await fs.readdir(join(f.root, "journal"))).filter((n) =>
      n.includes(".tmp-"),
    ).length,
    1,
  );
});
test("recovery: orphan temp without journal is not treated as empty history", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.root, "journal"));
  await fs.writeFile(
    join(
      f.root,
      "journal",
      "operations.json.tmp-00000000-0000-4000-8000-000000000000",
    ),
    "partial",
  );
  await assert.rejects(f.reserve(), /RECOVERY/);
});
test("recovery: legacy snapshot layout requires explicit migration, never silent replacement", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(join(f.root, "journal", "old-operation"), { recursive: true });
  await fs.writeFile(
    join(f.root, "journal", "old-operation", "00000000.json"),
    "{}",
  );
  await assert.rejects(f.reserve(), /MIGRATION/);
});
test("filesystem: directory sync unsupported is reported without claiming durability", async (t) => {
  const f = await fixture(t),
    original = fs.open,
    canonicalDirectory = join(await fs.realpath(f.root), "journal");
  let injected = 0;
  const fault = mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === canonicalDirectory && args[1] === "r") {
        injected++;
        throw Object.assign(new Error("synthetic"), { code: "ENOTSUP" });
      }
      return original(...args);
    },
  );
  try {
    await f.reserve();
  } finally {
    fault.mock.restore();
  }
  assert.equal(injected, 1);
  assert.equal(
    f.journal.durabilityStatus().directorySync,
    "unsupported-or-denied",
  );
  assert.equal(
    f.journal.durabilityStatus().physicalCrashDurability,
    "NOT VERIFIED",
  );
});
test("boundary: publisher remains disabled and executable sources have no database imports", async () => {
  assert.equal(new Publisher().remoteWritesEnabled, false);
  assert.throws(() => createProductionWriteExecutor(), /DISABLED/);
  async function scan(path: string): Promise<string[]> {
    return (
      await Promise.all(
        (await fs.readdir(path, { withFileTypes: true })).map((f) =>
          f.isDirectory()
            ? scan(join(path, f.name))
            : f.name.endsWith(".ts")
              ? [join(path, f.name)]
              : [],
        ),
      )
    ).flat();
  }
  for (const file of [...(await scan("tools")), ...(await scan("tests"))])
    assert.doesNotMatch(
      await fs.readFile(file, "utf8"),
      /from\s*["'](?:node:sqlite|sqlite3|better-sqlite3|mongoose|pg|@prisma\/client)["']/,
    );
});
test("filesystem: failed file flush leaves no consumed reservation or partial journal", async (t) => {
  const f = await fixture(t),
    original = fs.open;
  const fault = mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof fs.open>) => {
      const file = await original(...args);
      if (String(args[0]).includes("operations.json.tmp-"))
        mock.method(file, "sync", async () => {
          throw Object.assign(new Error("synthetic"), { code: "EIO" });
        });
      return file;
    },
  );
  try {
    await assert.rejects(f.reserve(), /WRITE_FAILED/);
  } finally {
    fault.mock.restore();
  }
  await assert.rejects(fs.readFile(f.path), { code: "ENOENT" });
  assert.equal(
    (await fs.readdir(join(f.root, "journal"))).filter((n) =>
      n.includes(".tmp-"),
    ).length,
    0,
  );
});
test("filesystem: post-rename failure marks outcome uncertain and blocks further writes", async (t) => {
  const f = await fixture(t),
    original = fs.open,
    canonicalDirectory = join(await fs.realpath(f.root), "journal");
  let injected = 0;
  const fault = mock.method(
    fs,
    "open",
    async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) === canonicalDirectory && args[1] === "r") {
        injected++;
        throw Object.assign(new Error("synthetic"), { code: "EIO" });
      }
      return original(...args);
    },
  );
  try {
    await assert.rejects(f.reserve(), /REPLACEMENT_UNCERTAIN/);
  } finally {
    fault.mock.restore();
  }
  assert.equal(injected, 1);
  assert.equal(
    JSON.parse(await fs.readFile(f.path, "utf8")).consumptions.length,
    1,
  );
  await assert.rejects(f.reserve(), /WRITE_UNCERTAIN/);
});
test("approval: expired attempt and backwards clock fail closed", async (t) => {
  const f = await fixture(t);
  const { entry } = await f.reserve();
  await f.journal.close();
  const later = f.open(() => fixtureNow + 60001);
  await assert.rejects(
    later.record({ ...entry, status: "Attempted" }),
    /EXPIRED_OR_PREVIOUS_SESSION/,
  );
  await later.close();
  const earlier = f.open(() => fixtureNow - 1);
  await assert.rejects(
    earlier.record({ ...entry, status: "Attempted" }),
    /CLOCK_ROLLBACK/,
  );
});

test("path: existing temporary root permits nonexistent journal descendants", async (t) => {
  const f = await fixture(t),
    root = await fs.realpath(f.root);
  const target = within(root, "journal/not-yet-created/value.json");
  await noSymlinks(root, target);
  assert.deepEqual(await f.journal.entries(f.request.operationId), []);
  assert.equal((await f.reserve()).entry.status, "Approved");
});
test("path: equivalent Windows short and long roots share ownership and history", async (t) => {
  const f = await fixture(t),
    canonical = await fs.realpath(f.root);
  if (f.root === canonical) {
    t.skip("No distinct short-form alias available on this filesystem");
    return;
  }
  const long = f.open(() => fixtureNow, canonical);
  const { entry } = await f.reserve();
  assert.equal(
    (await long.entries(entry.operationId)).at(-1)!.status,
    "Approved",
  );
  await long.record({ ...entry, status: "Attempted" });
  assert.equal(
    (await f.journal.entries(entry.operationId)).at(-1)!.status,
    "Attempted",
  );
});
test("path: case-equivalent roots share ownership on case-insensitive filesystems", async (t) => {
  const f = await fixture(t),
    variant = f.root.toUpperCase();
  try {
    if (
      relative(await fs.realpath(f.root), await fs.realpath(variant)) !== ""
    ) {
      t.skip("Case-sensitive filesystem");
      return;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      t.skip("Case-sensitive filesystem");
      return;
    }
    throw error;
  }
  const other = f.open(() => fixtureNow, variant);
  await f.reserve();
  assert.equal((await other.latestEntries()).length, 1);
});
test("path: relative traversal and absolute external targets stay rejected", async (t) => {
  const f = await fixture(t),
    root = await fs.realpath(f.root),
    outside = resolve(root, "..", "outside.json");
  assert.throws(() => within(root, "../outside.json"), /outside/);
  assert.throws(() => within(root, outside), /outside/);
  await assert.rejects(noSymlinks(root, outside), /Path escape/);
});
test("path: sibling prefix collision is outside, dot-dot-prefixed child is inside", async (t) => {
  const f = await fixture(t),
    root = await fs.realpath(f.root);
  assert.throws(() => within(root, root + "-sibling/value.json"), /outside/);
  const valid = within(root, "..safe-child/value.json");
  await noSymlinks(root, valid);
  assert.equal(valid, join(root, "..safe-child", "value.json"));
});
test("path: platform separators preserve containment", async (t) => {
  const f = await fixture(t),
    root = await fs.realpath(f.root);
  assert.equal(
    within(root, "journal/new.json"),
    join(root, "journal", "new.json"),
  );
  if (process.platform === "win32")
    assert.equal(
      within(root, "journal\\new.json"),
      join(root, "journal", "new.json"),
    );
});
test("path: journal junction or symlink escape is rejected without touching target", async (t) => {
  const f = await fixture(t),
    outside = f.root + "-outside";
  await fs.mkdir(outside);
  t.after(async () => {
    assert(outside.startsWith(join(tmpdir(), "agentic-json-journal-")));
    await fs.rm(outside, { recursive: true, force: true });
  });
  const marker = join(outside, "sentinel.txt");
  await fs.writeFile(marker, "unchanged");
  await fs.symlink(
    await fs.realpath(outside),
    join(f.root, "journal"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(f.reserve(), /Symlink/);
  assert.equal(await fs.readFile(marker, "utf8"), "unchanged");
  assert.deepEqual(await fs.readdir(outside), ["sentinel.txt"]);
});
test("path: junction root is rejected rather than rebased outside trusted boundary", async (t) => {
  const f = await fixture(t),
    rootAlias = join(f.root, "root-link");
  await fs.symlink(
    await fs.realpath(f.root),
    rootAlias,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    f.open(() => fixtureNow, rootAlias).latestEntries(),
    /Symlink journal roots/,
  );
});
