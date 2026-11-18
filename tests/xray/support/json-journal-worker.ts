/** Isolated ownership/interrupted-file fixture; fixed offline operations only. */
import fs from "node:fs/promises";
import { join } from "node:path";
import { mock } from "node:test";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { OperationJournal } from "../../../tools/xray/operation-journal.js";
import {
  jsonFixture,
  syntheticGate,
  fixtureNow,
} from "./json-journal-fixtures.js";
const deny = () => {
  process.stdout.write("NETWORK_DENIED\n");
  throw new Error("NETWORK_FORBIDDEN");
};
mock.method(globalThis, "fetch", deny);
mock.method(http, "request", deny);
mock.method(https, "request", deny);
mock.method(net.Socket.prototype, "connect", deny);
const [root, mode] = process.argv.slice(2);
if (!root) throw new Error("FIXTURE_ROOT_REQUIRED");
const { request, proposal } = jsonFixture();
try {
  const journal = new OperationJournal(root, () => fixtureNow);
  const handle = await syntheticGate(request).verify(
    "synthetic-approval",
    request,
  );
  await journal.consumeAndReserve(request, proposal.payload, handle);
  if (mode === "interrupted") {
    const file = await fs.open(
      join(
        root,
        "journal",
        "operations.json.tmp-00000000-0000-4000-8000-000000000000",
      ),
      "wx",
    );
    await file.writeFile('{"schemaVersion":');
    await file.sync();
    await file.close();
  }
  if (mode === "hold" || mode === "interrupted") {
    process.stdout.write("READY\n");
    setInterval(() => {}, 1000);
  } else {
    await journal.close();
    process.stdout.write("SUCCESS\n");
  }
} catch {
  process.stdout.write("DENIED\n");
  process.exitCode = 2;
}
