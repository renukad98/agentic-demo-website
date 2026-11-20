import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  approvedJira,
  prepareJira,
  recordJira,
} from "../../tools/agentic/chat-jira.js";

const cloudId = "https://jira.example.test";
const story = {
  key: "KAN-51",
  id: "10051",
  projectKey: "KAN",
  issueType: "Story" as const,
  summary: "Clear completed tasks",
  status: "To Do",
};
const draft = {
  summary: story.summary,
  description: "Provide a button on the task list.",
  acceptanceCriteria: [
    "Only the signed-in owner's completed tasks are cleared.",
  ],
};

async function fixture(t: TestContext, active = story.key) {
  const root = await mkdtemp(join(tmpdir(), "qa-jira-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const get = async (file: string) =>
    JSON.parse(await readFile(join(root, file), "utf8"));
  const put = async (file: string, value: unknown) => {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value));
  };
  const featureFile = `qa/${active}/feature.json`;
  const current = { storyKey: active, featureFile };
  await put("qa/current.json", current);
  await put("qa/pipeline.json", { stages: ["story", "requirements", "done"] });
  await put(featureFile, {
    storyKey: active,
    stage: "executed",
    paused: false,
    completedStages: ["requirements", "reviewed", "branch-ready", "executed"],
    pendingStages: ["done"],
    nextCommand: "qa close",
  });
  return { root, get, put, current, featureFile };
}

test("key intake is read-only even for a paused Story", async (t) => {
  const f = await fixture(t, "KAN-29");
  assert.deepEqual(await prepareJira(f.root, "qa story kan-29", { cloudId }), {
    kind: "intake",
    cloudId,
    storyKey: "KAN-29",
  });
  assert.deepEqual(await f.get("qa/current.json"), f.current);
  await assert.rejects(
    prepareJira(f.root, "qa implement", { cloudId }),
    /paused/,
  );
});

test("creation binds the exact preview and bootstraps only after verified readback", async (t) => {
  const f = await fixture(t, "KAN-25");
  const command = "qa story Clear completed tasks";
  const input = { cloudId, draft };
  const preview = await prepareJira(f.root, command, input);
  assert.equal(preview.kind, "create");
  if (preview.kind !== "create") throw new Error("Missing creation preview");
  assert.equal(preview.arguments.projectKey, "KAN");
  assert.match(
    preview.arguments.description,
    /## Acceptance criteria\n\n- Only/,
  );
  await assert.rejects(
    approvedJira(f.root, command, input, preview, ""),
    /requires OK/,
  );
  await assert.rejects(
    approvedJira(
      f.root,
      command,
      { cloudId, draft: { ...draft, summary: "Changed" } },
      preview,
      "OK",
    ),
    /requires OK/,
  );
  const created = {
    ...story,
    description:
      "Provide a **button** on the task list.\r\n\r\n### Acceptance criteria\r\n\r\n1. Only the signed-in owner's\r\n   *completed tasks* are cleared.",
  };
  const identity = { key: story.key, id: story.id };
  await assert.rejects(
    recordJira(f.root, command, input, preview, "OK", created, {
      ...identity,
      key: "KAN-52",
    }),
    /readback/,
  );
  await assert.rejects(
    recordJira(
      f.root,
      command,
      input,
      preview,
      "OK",
      { ...created, description: draft.description },
      identity,
    ),
    /readback/,
  );
  await assert.rejects(
    recordJira(
      f.root,
      command,
      input,
      preview,
      "OK",
      {
        ...created,
        summary: "Other story",
      },
      identity,
    ),
    /readback/,
  );
  assert.deepEqual(await f.get("qa/current.json"), f.current);
  await recordJira(f.root, command, input, preview, "OK", created, identity);
  const file = "qa/KAN-51/feature.json";
  assert.deepEqual(await f.get("qa/current.json"), {
    storyKey: story.key,
    featureFile: file,
  });
  assert.deepEqual(await f.get(file), {
    storyKey: story.key,
    title: story.summary,
    stage: "story",
    paused: false,
    completedStages: ["story"],
    pendingStages: ["requirements", "done"],
    nextCommand: "qa requirements",
  });
});

test("transition preview uses the available ID and Done requires matching readback", async (t) => {
  const f = await fixture(t);
  const input = {
    cloudId,
    story,
    transitions: [
      { id: "21", name: "Start work", to: "In Progress" },
      { id: "31", name: "Finish", to: "Done" },
    ],
  };
  const start = await prepareJira(f.root, "qa implement", input);
  assert.equal(start.kind, "transition");
  if (start.kind !== "transition")
    throw new Error("Missing transition preview");
  assert.equal(start.arguments.transitionId, "21");
  await recordJira(f.root, "qa implement", input, start, "OK", {
    ...story,
    status: "In Progress",
  });
  assert.equal((await f.get(f.featureFile)).stage, "executed");
  const close = await prepareJira(f.root, "qa close", input);
  await assert.rejects(
    approvedJira(
      f.root,
      "qa close",
      { ...input, transitions: [{ id: "99", name: "Finish", to: "Done" }] },
      close,
      "OK",
    ),
    /requires OK/,
  );
  await assert.rejects(
    recordJira(f.root, "qa close", input, close, "OK", story),
    /readback/,
  );
  assert.equal((await f.get(f.featureFile)).stage, "executed");
  await recordJira(f.root, "qa close", input, close, "OK", {
    ...story,
    status: "Done",
  });
  const closed = await f.get(f.featureFile);
  assert.equal(closed.stage, "done");
  assert.equal(closed.completedStages.at(-1), "done");
  assert.deepEqual(closed.pendingStages, []);
  assert.equal(closed.nextCommand, undefined);
});
