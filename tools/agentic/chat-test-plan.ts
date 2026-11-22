import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { noSymlinks, within } from "./artifacts.js";

const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/);
const issueId = z.string().regex(/^[1-9]\d*$/);

const featureSchema = z
  .object({
    storyKey: key,
    title: z.string().trim().min(1).optional(),
    stage: z.string(),
    paused: z.boolean().optional(),
    testPlanKey: key.optional(),
  })
  .passthrough();

async function load(root: string, command: string) {
  const match = /^qa test-plan(?: ([A-Z][A-Z0-9_]{0,9}-[1-9]\d*))?$/i.exec(
    command,
  );
  if (!match) throw new Error("Use qa test-plan [STORY-KEY]");
  const read = async (path: string) => {
    const file = within(root, path);
    await noSymlinks(root, file);
    return { file, source: await readFile(file, "utf8") };
  };
  const storyKey = match[1]
    ? key.parse(match[1].toUpperCase())
    : z
        .object({ storyKey: key })
        .parse(JSON.parse((await read("qa/current.json")).source)).storyKey;
  const { file, source } = await read(`qa/${storyKey}/feature.json`);
  const feature = featureSchema.parse(JSON.parse(source));
  if (feature.storyKey !== storyKey)
    throw new Error("Feature record Story does not match");
  if (
    feature.paused ||
    feature.stage === "paused" ||
    ["KAN-29", "KAN-30"].includes(storyKey)
  )
    throw new Error(`${storyKey} is paused`);
  const projectKey = storyKey.split("-")[0]!;
  if (
    feature.testPlanKey &&
    (!feature.testPlanKey.startsWith(projectKey + "-") ||
      feature.testPlanKey === storyKey)
  )
    throw new Error(
      "Saved Test Plan key does not match the Story project or refers to the Story itself",
    );
  const operations = [];
  if (!feature.testPlanKey) {
    if (!feature.title)
      throw new Error("The feature record needs a Story title");
    const summary = z
      .string()
      .max(255)
      .parse(`Agentic Demo Website – ${feature.title}`);
    operations.push({ tool: "xray_create_test_plan", projectKey, summary });
  }
  operations.push({
    tool: "jira_link_issues",
    linkType: "Relates",
    inwardKey: feature.testPlanKey ?? null,
    outwardKey: storyKey,
  });
  return { file, source, preview: { storyKey, projectKey, operations } };
}

export async function previewTestPlan(root: string, command: string) {
  return (await load(root, command)).preview;
}

const evidenceSchema = z.object({
  preview: z.unknown(),
  plan: z.object({ key, issueId }),
  link: z.object({
    status: z.enum(["linked", "already-linked"]),
    inwardKey: key,
    outwardKey: key,
    linkId: issueId,
  }),
});

export async function recordTestPlan(
  root: string,
  command: string,
  evidence: unknown,
) {
  const { file, source, preview } = await load(root, command);
  const { preview: approved, plan, link } = evidenceSchema.parse(evidence);
  if (JSON.stringify(approved) !== JSON.stringify(preview))
    throw new Error("The approved Test Plan preview changed");
  const feature = featureSchema.parse(JSON.parse(source));
  if (
    !plan.key.startsWith(preview.projectKey + "-") ||
    plan.key === preview.storyKey ||
    (feature.testPlanKey && feature.testPlanKey !== plan.key) ||
    link.inwardKey !== plan.key ||
    link.outwardKey !== preview.storyKey
  )
    throw new Error(
      "Verified Test Plan or link does not match the approved Story",
    );

  if (feature.testPlanKey !== plan.key) {
    const temp = resolve(dirname(file), `.${randomUUID()}.tmp`);
    try {
      await writeFile(
        temp,
        JSON.stringify(
          { ...JSON.parse(source), testPlanKey: plan.key },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
      if ((await readFile(file, "utf8")) !== source)
        throw new Error("The Story feature record changed before saving");
      await rename(temp, file);
    } finally {
      await rm(temp, { force: true });
    }
  }
  return {
    storyKey: preview.storyKey,
    testPlanKey: plan.key,
    linkStatus: link.status,
  };
}

async function main() {
  const [action, command, ...extra] = process.argv.slice(2);
  if (!command || extra.length || !["preview", "record"].includes(action ?? ""))
    throw new Error(
      'Usage: tsx tools/agentic/chat-test-plan.ts preview|record "qa test-plan [STORY-KEY]"',
    );
  const root = process.cwd();
  if (action === "preview") {
    console.log(JSON.stringify(await previewTestPlan(root, command), null, 2));
    return;
  }
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  console.log(
    JSON.stringify(
      await recordTestPlan(root, command, JSON.parse(input)),
      null,
      2,
    ),
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Test Plan command failed",
    );
    process.exitCode = 1;
  });
}
