import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fingerprint, noSymlinks, objectDigest, within } from "./artifacts.js";
import {
  hasAcceptedDesignReview,
  isStoryPaused,
  resolveQaNext,
} from "./qa-next.js";
import { storyKey } from "./contracts/index.js";

const caseId = z.string().regex(/^[A-Z][A-Z0-9-]*-TC-\d+$/);
const featureRecord = z
  .object({
    storyKey,
    paused: z.boolean().optional(),
    stage: z.string(),
    completedStages: z.array(z.string()),
    pendingStages: z.array(z.string()),
    evidence: z
      .object({ testDesign: z.string(), testReview: z.string() })
      .passthrough(),
  })
  .passthrough();

export async function loadChatXray(root: string, command: string) {
  const match = /^qa xray(?: ([A-Z][A-Z0-9]*-\d+))?$/i.exec(command);
  if (!match) throw new Error("Use qa xray or qa xray <STORY-KEY>");
  const read = async (path: string) => {
    const target = within(root, path);
    await noSymlinks(root, target);
    return readFile(target, "utf8");
  };
  const json = async (path: string): Promise<unknown> =>
    JSON.parse(await read(path));
  const key = match[1]?.toUpperCase();
  const selected = key
    ? { storyKey: storyKey.parse(key), featureFile: `qa/${key}/feature.json` }
    : z
        .object({ storyKey, featureFile: z.string() })
        .parse(await json("qa/current.json"));
  if (["KAN-29", "KAN-30"].includes(selected.storyKey))
    throw new Error(
      `${selected.storyKey} is paused under the repository policy`,
    );
  if (selected.featureFile !== `qa/${selected.storyKey}/feature.json`)
    throw new Error("Invalid Story feature record path");
  const feature = featureRecord.parse(
    await json(selected.featureFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT")
        throw new Error(
          `No QA feature record for ${selected.storyKey} at ${selected.featureFile}`,
        );
      throw error;
    }),
  );
  if (feature.storyKey !== selected.storyKey || isStoryPaused(feature))
    throw new Error("Story is paused or the feature record does not match");
  if (!feature.completedStages.includes("reviewed"))
    throw new Error("Accepted test design review is required");
  if (feature.completedStages.includes("published"))
    throw new Error("Manual Tests are already published for this Story");
  const evidence = (path: string) => {
    if (
      !path.startsWith(`artifacts/qa/${feature.storyKey}/`) ||
      path.split(/[\\/]/).includes("..")
    )
      throw new Error("Evidence must belong to the selected Story");
    return read(path);
  };
  const [design, review, pipeline] = await Promise.all([
    evidence(feature.evidence.testDesign),
    evidence(feature.evidence.testReview),
    json("qa/pipeline.json"),
  ]);
  if (!hasAcceptedDesignReview(review, fingerprint(design)))
    throw new Error(
      "The accepted review must reference the exact testDesign SHA-256",
    );
  const { folderPath } = z
    .object({
      commands: z.object({
        "qa xray": z.object({
          chatManualTests: z.object({
            folderPath: z.string().trim().min(1).optional(),
          }),
        }),
      }),
    })
    .parse(pipeline).commands["qa xray"].chatManualTests;
  return {
    storyKey: selected.storyKey,
    featureFile: selected.featureFile,
    mappingFile: `artifacts/qa/${selected.storyKey}/xray-test-keys.json`,
    featureDigest: objectDigest(feature),
    evidenceDigest: objectDigest({
      feature,
      design,
      review,
      folder: folderPath ?? null,
    }),
    folderPath,
    cases: parseReviewedCases(design, selected.storyKey),
  };
}

export function parseReviewedCases(markdown: string, key: string) {
  if (
    !markdown
      .split(/\r?\n/)
      .some((line) =>
        new RegExp(`^(?:# .*\\b${key}\\b|Story ${key};)`).test(line),
      )
  )
    throw new Error("Test design must identify the selected Story");
  const ids = new Set<string>();
  const cases = [];
  for (const section of markdown.split(/^## /m).slice(1)) {
    const [heading, ...lines] = section.split(/\r?\n/);
    const match = /^(\S+)[ \t]+—[ \t]+(.+)$/.exec(heading ?? "");
    if (!match) {
      if (heading?.includes("-TC-")) throw new Error("Invalid case heading");
      continue;
    }
    if (!match[1]?.includes("-TC-")) continue;
    const id = caseId.parse(match[1]);
    if (ids.has(id)) throw new Error(`Duplicate case ID: ${id}`);
    ids.add(id);
    const summary = z.string().max(255).parse(`${id}: ${match[2]?.trim()}`);
    const setup = lines.flatMap((line) => {
      const value =
        /^- Preconditions(?:\/data| and isolated test-data setup)?: (.+)$/.exec(
          line,
        );
      return value?.[1] ? [value[1].trim()] : [];
    });
    const table = lines.filter((line) => line.startsWith("|"));
    const header = table[0]?.replace(/\s/g, "");
    const hasData =
      header === "|Step|Action|Testdata|Expectedobservableresult|";
    if (
      setup.length !== 1 ||
      (!hasData && header !== "|Step|Action/input|Expectedobservableresult|") ||
      !/^\|[ |:-]+\|$/.test(table[1] ?? "") ||
      table.length < 3 ||
      table.length > 101
    )
      throw new Error(`Missing or invalid reviewed steps for ${id}`);
    const steps = table.slice(2).map((line, index) => {
      const cells = line
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replace(/\\\|/g, "|"));
      if (
        cells.length !== (hasData ? 6 : 5) ||
        cells[1] !== String(index + 1) ||
        !cells[2] ||
        !cells.at(-2) ||
        cells[0] ||
        cells.at(-1)
      )
        throw new Error(`Invalid reviewed step for ${id}`);
      return {
        action: cells[2],
        data: hasData ? cells[3]! : "",
        result: cells.at(-2)!,
      };
    });
    steps.unshift({
      action: `Preconditions: ${setup[0]}`,
      data: "",
      result: "Preconditions met",
    });
    cases.push({ caseId: id, summary, steps });
  }
  if (!cases.length) throw new Error("No reviewed Manual Test cases found");
  return cases;
}

export async function markChatXrayPublished(root: string, record: unknown) {
  const feature = featureRecord.parse(record);
  if (isStoryPaused(feature) || !feature.completedStages.includes("reviewed"))
    throw new Error("Story is paused or has no accepted design review");
  const pendingStages = feature.pendingStages.filter(
    (stage) => stage !== "published",
  );
  const updated = {
    ...feature,
    stage: "published",
    completedStages: [...new Set([...feature.completedStages, "published"])],
    pendingStages,
  };
  return { ...updated, ...(await resolveQaNext(root, updated)) };
}

type Case = ReturnType<typeof parseReviewedCases>[number];
type RemoteTest = {
  issueId: string;
  key: string;
  summary: string;
};
export type ReviewedRemoteTest = RemoteTest & {
  manual: boolean;
  steps: Case["steps"];
  linked: boolean;
};

export async function reviewChatXrayDuplicates(
  cases: Case[],
  list: (start: number) => Promise<{ total: number; results: RemoteTest[] }>,
  inspect: (candidate: RemoteTest) => Promise<ReviewedRemoteTest>,
  keys: Record<string, string>,
) {
  const inventory: RemoteTest[] = [];
  let total: number | undefined;
  do {
    const page = await list(inventory.length);
    total ??= page.total;
    if (
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total !== page.total ||
      inventory.length + page.results.length > total ||
      (!page.results.length && inventory.length < total)
    )
      throw new Error("Inconsistent Xray inventory pagination");
    inventory.push(...page.results);
  } while (inventory.length < total);
  if (
    new Set(inventory.map((test) => test.issueId)).size !== total ||
    new Set(inventory.map((test) => test.key)).size !== total
  )
    throw new Error("Duplicate Xray inventory identity");

  const rows = [];
  const assigned = new Set<string>();
  for (const item of cases) {
    const caseToken = new RegExp(
      `(?:^|[^A-Z0-9_-])${caseId.parse(item.caseId)}(?=$|[^A-Z0-9_-])`,
      "i",
    );
    const candidates = inventory.filter(
      (candidate) =>
        candidate.key === keys[item.caseId] ||
        caseToken.test(candidate.summary) ||
        candidate.summary.trim().toLowerCase() ===
          item.summary
            .slice(item.caseId.length + 2)
            .trim()
            .toLowerCase(),
    );
    if (!candidates.length && !keys[item.caseId]) {
      rows.push({ ...item, decision: "create" as const });
      continue;
    }
    if (candidates.length !== 1)
      throw new Error(`Ambiguous Xray candidates for ${item.caseId}`);
    const candidate = candidates[0]!;
    const remote = await inspect(candidate);
    if (
      remote.issueId !== candidate.issueId ||
      remote.key !== candidate.key ||
      (keys[item.caseId] && remote.key !== keys[item.caseId]) ||
      !remote.manual ||
      objectDigest(remote.steps) !== objectDigest(item.steps)
    )
      throw new Error(`Unresolved Xray duplicate for ${item.caseId}`);
    if (assigned.has(remote.key))
      throw new Error(
        `Xray Test ${remote.key} matches multiple reviewed cases`,
      );
    assigned.add(remote.key);
    rows.push({
      ...item,
      decision: remote.linked ? ("skip" as const) : ("reuse" as const),
      remote,
    });
  }
  return rows;
}

async function updateJson(
  root: string,
  path: string,
  update: (value: unknown) => unknown,
  initial?: unknown,
) {
  const target = within(root, path);
  const lock = target + ".lock";
  const temporary = target + "." + randomUUID() + ".tmp";
  await noSymlinks(root, target);
  await writeFile(lock, "", { flag: "wx" });
  try {
    const previous = await readFile(target, "utf8").then(
      (body) => JSON.parse(body) as unknown,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && initial !== undefined) return initial;
        throw error;
      },
    );
    await writeFile(
      temporary,
      JSON.stringify(await update(previous), null, 2) + "\n",
      { flag: "wx" },
    );
    await rename(temporary, target);
  } finally {
    await unlink(temporary)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      })
      .finally(() => unlink(lock));
  }
}

const mappingSchema = z.record(caseId, storyKey);
type PreviewRows = Awaited<ReturnType<typeof reviewChatXrayDuplicates>>;

export function renderChatXrayPreview(
  plan: {
    storyKey: string;
    folderPath?: string | undefined;
    rows: PreviewRows;
  },
  tenant: string,
  writeToolsAvailable: boolean,
) {
  const cell = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\|/g, "&#124;")
      .replace(/`/g, "&#96;")
      .replace(/\r?\n/g, "<br>");
  const project = plan.storyKey.split("-")[0]!;
  const lines = [
    `Tenant ${cell(tenant)} · Project ${cell(project)} · Story ${cell(plan.storyKey)}`,
    "",
    "| Case | Summary | Folder | Decision | Ordered action / data / result | Story link |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const row of plan.rows) {
    const steps = row.steps
      .map(
        ({ action, data, result }, index) =>
          `${index + 1}. <code>${cell(action)}</code> / <code>${cell(data || '""')}</code> / <code>${cell(result)}</code>`,
      )
      .join("<br>");
    const key = row.decision === "create" ? "New Test" : row.remote.key;
    const link = row.decision === "skip" ? "verified existing" : "proposed";
    lines.push(
      `| ${cell(row.caseId)} | ${cell(row.summary)} | ${cell(plan.folderPath ?? "None")} | ${row.decision} | ${steps} | ${cell(key)} tests ${cell(plan.storyKey)} (${link}) |`,
    );
  }
  return [
    ...lines,
    "",
    "**What's next?**",
    writeToolsAvailable
      ? "Reply OK to approve these exact Manual Test creations and Story links."
      : "Set `[Environment]::SetEnvironmentVariable('XRAY_ENABLE_WRITES', 'true', 'User')`, fully restart VS Code, and rerun the same command.",
  ].join("\n");
}

const remoteTestSchema = z.object({
  issueId: z.string().regex(/^\d+$/),
  key: storyKey,
  summary: z.string(),
});
const duplicatePacket = z.object({
  pages: z
    .array(z.object({ total: z.number(), results: z.array(remoteTestSchema) }))
    .min(1),
  details: z.array(
    remoteTestSchema.extend({
      manual: z.boolean(),
      linked: z.boolean(),
      steps: z.array(
        z.object({ action: z.string(), data: z.string(), result: z.string() }),
      ),
    }),
  ),
});

async function evaluateDuplicatePacket(
  root: string,
  command: string,
  packetPath: string,
) {
  const plan = await loadChatXray(root, command);
  if (
    !packetPath.startsWith(`artifacts/qa/${plan.storyKey}/`) ||
    packetPath.split(/[\\/]/).includes("..")
  )
    throw new Error("Duplicate packet must belong to the selected Story");
  const packet = within(root, packetPath);
  const mapping = within(root, plan.mappingFile);
  await noSymlinks(root, packet);
  await noSymlinks(root, mapping);
  const { pages, details } = duplicatePacket.parse(
    JSON.parse(await readFile(packet, "utf8")),
  );
  const keys = await readFile(mapping, "utf8").then(
    (body) => mappingSchema.parse(JSON.parse(body)),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return {};
      throw error;
    },
  );
  let page = 0;
  const rows = await reviewChatXrayDuplicates(
    plan.cases,
    async () => {
      const next = pages[page++];
      if (!next) throw new Error("Missing Xray inventory page");
      return next;
    },
    async (candidate) => {
      const matches = details.filter(
        (detail) => detail.issueId === candidate.issueId,
      );
      if (matches.length !== 1)
        throw new Error(`Missing or ambiguous detail for ${candidate.key}`);
      return matches[0]!;
    },
    keys,
  );
  if (page !== pages.length) throw new Error("Unexpected Xray inventory page");
  return { ...plan, rows };
}

export async function recordChatXrayKey(
  root: string,
  story: string,
  rawCaseId: string,
  key: string,
) {
  storyKey.parse(story);
  caseId.parse(rawCaseId);
  storyKey.parse(key);
  if (key.split("-")[0] !== story.split("-")[0])
    throw new Error("Verified Test key must belong to the Story project");
  await updateJson(
    root,
    `artifacts/qa/${story}/xray-test-keys.json`,
    (value) => {
      const keys = mappingSchema.parse(value);
      if (
        (keys[rawCaseId] && keys[rawCaseId] !== key) ||
        Object.entries(keys).some(
          ([id, assigned]) => id !== rawCaseId && assigned === key,
        )
      )
        throw new Error("Conflicting Xray key mapping");
      return { ...keys, [rawCaseId]: key };
    },
    {},
  );
}

export async function completeChatXray(
  root: string,
  command: string,
  digest: string,
  rawVerified: unknown,
) {
  const plan = await loadChatXray(root, command);
  if (plan.evidenceDigest !== digest)
    throw new Error("Xray publication evidence changed");
  const verified = mappingSchema.parse(rawVerified);
  const mapping = within(root, plan.mappingFile);
  await noSymlinks(root, mapping);
  const keys = mappingSchema.parse(JSON.parse(await readFile(mapping, "utf8")));
  if (
    Object.keys(verified).length !== plan.cases.length ||
    plan.cases.some(
      ({ caseId }) => !verified[caseId] || keys[caseId] !== verified[caseId],
    )
  )
    throw new Error(
      "Every reviewed case requires a verified Story link and saved Test key",
    );
  await updateJson(root, plan.featureFile, (record) => {
    if (objectDigest(featureRecord.parse(record)) !== plan.featureDigest)
      throw new Error("Feature record changed during publication");
    return markChatXrayPublished(root, record);
  });
}

async function main() {
  const [operation, command, ...args] = process.argv.slice(2);
  const root = process.cwd();
  if (operation === "load" && command && !args.length) {
    process.stdout.write(
      JSON.stringify(await loadChatXray(root, command), null, 2) + "\n",
    );
  } else if (operation === "duplicates" && command && args.length === 1) {
    process.stdout.write(
      JSON.stringify(
        await evaluateDuplicatePacket(root, command, args[0]!),
        null,
        2,
      ) + "\n",
    );
  } else if (operation === "preview" && command && args.length === 3) {
    const [packet, tenant, mode] = args;
    if (mode !== "read-only" && mode !== "write-enabled")
      throw new Error("Specify the discovered session mode");
    const plan = await evaluateDuplicatePacket(root, command, packet!);
    process.stdout.write(
      renderChatXrayPreview(
        plan,
        new URL(tenant!).origin,
        mode === "write-enabled",
      ) + "\n",
    );
  } else if (operation === "record" && command && args.length === 2) {
    await recordChatXrayKey(root, command, args[0]!, args[1]!);
  } else if (operation === "complete" && command && args.length === 2) {
    await completeChatXray(root, command, args[0]!, JSON.parse(args[1]!));
  } else {
    throw new Error(
      "Use load <qa command>, duplicates <qa command> <packet>, preview <qa command> <packet> <tenant URL> <mode>, record <Story> <case> <Test key>, or complete <qa command> <evidence digest> <verified links JSON>",
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      (error instanceof Error ? error.message : String(error)) + "\n",
    );
    process.exitCode = 1;
  });
}
