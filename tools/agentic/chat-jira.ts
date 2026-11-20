import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  canonical,
  fingerprint,
  noSymlinks,
  within,
  writeExclusive,
} from "./artifacts.js";

const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/);
const pointer = z.object({ storyKey: key, featureFile: z.string() });
const feature = z
  .object({
    storyKey: key,
    stage: z.string(),
    paused: z.boolean().optional(),
    completedStages: z.array(z.string()).default([]),
    pendingStages: z.array(z.string()).default([]),
  })
  .passthrough();
const issue = z.object({
  key,
  id: z.string().regex(/^[1-9]\d*$/),
  projectKey: z.string(),
  issueType: z.literal("Story"),
  summary: z.string().min(1),
  description: z.string().optional(),
  status: z.string(),
});
const context = z.object({
  cloudId: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.href === url.origin + "/";
    }),
  story: issue.optional(),
  transitions: z
    .array(
      z.object({ id: z.string().min(1), name: z.string(), to: z.string() }),
    )
    .optional(),
  draft: z
    .object({
      summary: z.string().trim().min(1).max(255),
      description: z.string().trim().min(1),
      acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
    })
    .optional(),
});
type Context = z.infer<typeof context>;

async function read(root: string, relative: string) {
  const file = within(root, relative);
  await noSymlinks(root, file);
  return { file, source: await readFile(file, "utf8") };
}

function assertActive(storyKey: string, stage?: string, paused?: boolean) {
  if (paused || stage === "paused" || ["KAN-29", "KAN-30"].includes(storyKey))
    throw new Error(`${storyKey} is paused`);
}

async function replace(file: string, value: unknown, expected: string) {
  const temp = resolve(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, json(value), { flag: "wx" });
    if ((await readFile(file, "utf8")) !== expected)
      throw new Error("QA record changed");
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

function json(value: unknown) {
  return JSON.stringify(value, null, 2) + "\n";
}

export async function prepareJira(
  root: string,
  command: string,
  input: Context,
) {
  const { cloudId, story, transitions, draft } = context.parse(input);
  const argument = /^qa story\s+(.+)$/is.exec(command)?.[1]?.trim();
  if (argument && key.safeParse(argument.toUpperCase()).success)
    return {
      kind: "intake" as const,
      cloudId,
      storyKey: argument.toUpperCase(),
    };

  const current = await read(root, "qa/current.json");
  if (argument) {
    if (!draft)
      throw new Error(
        "A summary, description and acceptance criteria are required",
      );
    const { stages } = z
      .object({ stages: z.array(z.string()) })
      .parse(JSON.parse((await read(root, "qa/pipeline.json")).source));
    if (stages[0] !== "story" || new Set(stages).size !== stages.length)
      throw new Error("Invalid QA pipeline stages");
    return {
      kind: "create" as const,
      tool: "createJiraIssue",
      arguments: {
        cloudId,
        projectKey: "KAN",
        issueType: "Story",
        summary: draft.summary,
        description:
          draft.description +
          "\n\n## Acceptance criteria\n\n" +
          draft.acceptanceCriteria.map((item) => "- " + item).join("\n"),
      },
      pendingStages: stages.slice(1),
      currentRevision: digest(current.source),
    };
  }

  const target =
    command === "qa implement"
      ? "In Progress"
      : command === "qa close"
        ? "Done"
        : undefined;
  if (!target)
    throw new Error(
      "Use qa story <description|KEY>, qa implement, or qa close",
    );
  const selected = pointer.parse(JSON.parse(current.source));
  if (selected.featureFile !== `qa/${selected.storyKey}/feature.json`)
    throw new Error("Invalid active feature path");
  const record = await read(root, selected.featureFile);
  const state = feature.parse(JSON.parse(record.source));
  if (state.storyKey !== selected.storyKey)
    throw new Error("Active Story mismatch");
  assertActive(state.storyKey, state.stage, state.paused);
  if (
    target === "In Progress" &&
    !["requirements", "reviewed", "branch-ready"].every((stage) =>
      state.completedStages.includes(stage),
    )
  )
    throw new Error(
      "Accepted requirements, design review and branch handoff are required",
    );
  if (target === "Done" && !state.completedStages.includes("executed"))
    throw new Error("Verified QA execution is required before closeout");
  if (
    !story ||
    story.key !== selected.storyKey ||
    !story.key.startsWith(story.projectKey + "-")
  )
    throw new Error("Verified active Jira Story required");
  const matches =
    transitions?.filter((transition) => transition.to === target) ?? [];
  if (story.status !== target && matches.length !== 1)
    throw new Error(`Expected one available Jira transition to ${target}`);
  return {
    kind: "transition" as const,
    tool: "transitionJiraIssue",
    storyId: story.id,
    projectKey: story.projectKey,
    from: story.status,
    to: target,
    arguments: {
      cloudId,
      issueIdOrKey: story.key,
      transitionId: story.status === target ? null : matches[0]!.id,
    },
    currentRevision: digest(current.source),
    featureRevision: digest(record.source),
  };
}

function digest(source: string) {
  return fingerprint(source);
}

export async function approvedJira(
  root: string,
  command: string,
  input: Context,
  preview: unknown,
  reply: string,
) {
  const fresh = await prepareJira(root, command, input);
  if (
    fresh.kind === "intake" ||
    reply.trim().toUpperCase() !== "OK" ||
    canonical(fresh) !== canonical(preview)
  )
    throw new Error("The latest exact Jira preview requires OK");
  return fresh;
}

function markdownText(value: string) {
  return value
    .replace(/^\s{0,3}(?:#{1,6}\s+|(?:[-+*]|\d+[.)])\s+)/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\\([\\\x60*_{}\[\]()#+.!~-])/g, "$1")
    .replace(/(\*\*|__|~~|\x60+)(.+?)\1/g, "$2")
    .replace(/(\*|_)(\S(?:.*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

export async function recordJira(
  root: string,
  command: string,
  input: Context,
  preview: unknown,
  reply: string,
  readback: unknown,
  createdIdentity?: unknown,
) {
  const approved = await approvedJira(root, command, input, preview, reply);
  const story = issue.parse(readback);
  const current = await read(root, "qa/current.json");
  if (approved.currentRevision !== digest(current.source))
    throw new Error("Active Story changed");
  if (approved.kind === "create") {
    const identity = issue.pick({ key: true, id: true }).parse(createdIdentity);
    const description = markdownText(story.description ?? "");
    const draft = context.parse(input).draft!;
    if (
      story.key !== identity.key ||
      story.id !== identity.id ||
      story.projectKey !== approved.arguments.projectKey ||
      !story.key.startsWith(story.projectKey + "-") ||
      story.summary !== approved.arguments.summary ||
      ![draft.description, ...draft.acceptanceCriteria].every((part) => {
        const expected = markdownText(part);
        return expected.length > 0 && description.includes(expected);
      })
    )
      throw new Error(
        "Created Story readback does not match the approved payload",
      );
    assertActive(story.key);
    const featureFile = `qa/${story.key}/feature.json`;
    const file = within(root, featureFile);
    await noSymlinks(root, file);
    const created = {
      storyKey: story.key,
      title: story.summary,
      stage: "story",
      paused: false,
      completedStages: ["story"],
      pendingStages: approved.pendingStages,
      nextCommand: "qa requirements",
    };
    try {
      await writeExclusive(root, featureFile, created);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await readFile(file, "utf8")) !== json(created)
      )
        throw error;
    }
    await replace(
      current.file,
      { storyKey: story.key, featureFile },
      current.source,
    );
  } else {
    if (
      story.key !== approved.arguments.issueIdOrKey ||
      story.id !== approved.storyId ||
      story.projectKey !== approved.projectKey ||
      story.status !== approved.to
    )
      throw new Error(
        "Jira transition readback does not match the approved target",
      );
    if (approved.to === "Done") {
      const selected = pointer.parse(JSON.parse(current.source));
      const record = await read(root, selected.featureFile);
      if (approved.featureRevision !== digest(record.source))
        throw new Error("Feature record changed");
      const state = feature.parse(JSON.parse(record.source));
      delete state.nextCommand;
      await replace(
        record.file,
        {
          ...state,
          stage: "done",
          completedStages: [...new Set([...state.completedStages, "done"])],
          pendingStages: state.pendingStages.filter(
            (stage) => stage !== "done",
          ),
        },
        record.source,
      );
    }
  }
  return { storyKey: story.key, status: story.status };
}

async function main() {
  const [action, command, ...extra] = process.argv.slice(2);
  if (
    !command ||
    extra.length ||
    !["preview", "check", "record"].includes(action ?? "")
  )
    throw new Error(
      'Usage: tsx tools/agentic/chat-jira.ts preview|check|record "qa <command>"',
    );
  process.stdin.setEncoding("utf8");
  let source = "";
  for await (const chunk of process.stdin) source += chunk;
  const packet = z
    .object({
      context,
      preview: z.unknown().optional(),
      reply: z.string().optional(),
      readback: z.unknown().optional(),
      createdIdentity: z.unknown().optional(),
    })
    .parse(JSON.parse(source));
  const root = process.cwd();
  const result =
    action === "preview"
      ? await prepareJira(root, command, packet.context)
      : action === "check"
        ? await approvedJira(
            root,
            command,
            packet.context,
            packet.preview,
            packet.reply ?? "",
          )
        : await recordJira(
            root,
            command,
            packet.context,
            packet.preview,
            packet.reply ?? "",
            packet.readback,
            packet.createdIdentity,
          );
  process.stdout.write(json(result));
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Jira QA command failed",
    );
    process.exitCode = 1;
  });
}
