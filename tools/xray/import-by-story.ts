import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { noSymlinks, within } from "../agentic/artifacts.js";
import {
  addProperty,
  caseId,
  issueKey,
  junitOutcome,
  parseJUnit,
  propertyValues,
  storyJUnitReport,
  summarizeJUnit,
} from "./playwright-junit.js";

const key = z.string().regex(issueKey);
const featureSchema = z
  .object({
    storyKey: key,
    stage: z.string(),
    paused: z.boolean().optional(),
    completedStages: z.array(z.string()).optional(),
    testPlanKey: key.optional(),
  })
  .passthrough();

export interface ResultsOptions {
  root: string;
  story?: string | undefined;
  report?: string | undefined;
  dryRun?: boolean | undefined;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch | undefined;
  print?: ((message: string) => void) | undefined;
}

function httpsOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.href !== url.origin + "/")
    throw new Error("Xray and Jira must be configured as HTTPS origins");
  return url.origin;
}

async function safePath(root: string, path: string) {
  const target = within(root, path);
  await noSymlinks(root, target);
  return target;
}

async function loadFeature(root: string, story: string) {
  const file = await safePath(root, `qa/${story}/feature.json`);
  const source = await readFile(file, "utf8");
  const feature = featureSchema.parse(JSON.parse(source));
  if (feature.storyKey !== story)
    throw new Error(`Feature record disagrees with ${story}`);
  return { file, source, feature };
}

function resultReport(rows: Element[]) {
  const document = parseJUnit("<testsuites><testsuite/></testsuites>");
  const suite = document.documentElement.firstElementChild!;
  suite.setAttribute("name", "Playwright");
  const rank = { passed: 0, skipped: 1, failure: 2, error: 3 };
  const observations = rows.map((row) => ({
    caseId: propertyValues(row, "case_id")[0]!,
    testKey: propertyValues(row, "test_key")[0]!,
    name: row.getAttribute("name") ?? "",
    outcome: junitOutcome(row),
  }));
  const selected = new Map<string, Element>();
  for (const [index, observation] of observations.entries()) {
    const previous = selected.get(observation.testKey);
    if (!previous || rank[observation.outcome] > rank[junitOutcome(previous)])
      selected.set(observation.testKey, rows[index]!);
  }
  for (const row of selected.values()) {
    const test = document.createElement("testcase");
    for (const name of ["name", "classname", "time"]) {
      const value = row.getAttribute(name);
      if (value !== null) test.setAttribute(name, value);
    }
    for (const name of ["story", "case_id", "test_key"]) {
      for (const value of propertyValues(row, name))
        addProperty(test, name, value);
    }
    const outcome = junitOutcome(row);
    if (outcome !== "passed") test.append(document.createElement(outcome));
    suite.append(test);
  }
  summarizeJUnit(suite);
  summarizeJUnit(document.documentElement);
  return { payload: document.documentElement.outerHTML + "\n", observations };
}

export async function prepareStoryResults(options: ResultsOptions) {
  const { root, report = storyJUnitReport, story, env } = options;
  if (story) key.parse(story);
  const origin = httpsOrigin(
    env.XRAY_BASE_URL?.trim() || "https://xray.cloud.getxray.app",
  );
  const tenant = env.JIRA_BASE_URL?.trim()
    ? httpsOrigin(env.JIRA_BASE_URL.trim())
    : null;
  const xml = await readFile(await safePath(root, report), "utf8");
  const document = parseJUnit(xml);
  const tests = [...document.querySelectorAll("testcase")];
  const groups = new Map<string, Element[]>();
  const skipped: { story: string; reason: string }[] = [];
  const notPublished: { story: string; caseId: string; test: string }[] = [];
  for (const test of tests) {
    const name = test.getAttribute("name") ?? "";
    const stories = propertyValues(test, "story");
    if (stories.length !== 1 || !issueKey.test(stories[0] ?? ""))
      throw new Error(`Missing or invalid story on JUnit test ${name}`);
    const storyKey = stories[0]!;
    const ids = propertyValues(test, "case_id");
    const keys = propertyValues(test, "test_key");
    const publication = propertyValues(test, "publication");
    if (
      !keys.length &&
      publication.length === 1 &&
      publication[0] === "not published"
    ) {
      if (!story || story === storyKey)
        notPublished.push({
          story: storyKey,
          caseId: ids[0] ?? "",
          test: name,
        });
      continue;
    }
    if (keys.length !== 1 || !issueKey.test(keys[0] ?? ""))
      throw new Error(`Missing or invalid test_key on JUnit test ${name}`);
    if (!story || story === storyKey) {
      const rows = groups.get(storyKey) ?? [];
      rows.push(test);
      groups.set(storyKey, rows);
    }
  }

  const imports = [];
  for (const [storyKey, rows] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const { feature } = await loadFeature(root, storyKey);
    const reason =
      feature.paused || ["KAN-29", "KAN-30"].includes(storyKey)
        ? "story paused"
        : feature.stage === "done" || feature.completedStages?.includes("done")
          ? "story done"
          : !feature.testPlanKey
            ? "no testPlanKey"
            : undefined;
    if (reason) {
      skipped.push({ story: storyKey, reason });
      continue;
    }
    const projectKey = storyKey.split("-")[0]!;
    const testPlanKey = feature.testPlanKey!;
    if (!testPlanKey.startsWith(projectKey + "-"))
      throw new Error(`Test Plan ${testPlanKey} is outside the Story project`);

    const mapping = z
      .record(z.string().regex(caseId), key)
      .parse(
        JSON.parse(
          await readFile(
            await safePath(
              root,
              `artifacts/qa/${storyKey}/xray-test-keys.json`,
            ),
            "utf8",
          ),
        ),
      );
    for (const row of rows) {
      const ids = propertyValues(row, "case_id");
      const id = ids[0] ?? "";
      if (
        ids.length !== 1 ||
        mapping[id] !== propertyValues(row, "test_key")[0]
      )
        throw new Error(
          `Published Test mapping changed for ${storyKey} ${id}; regenerate JUnit`,
        );
    }
    const endpoint = new URL("/api/v2/import/execution/junit", origin);
    endpoint.search = new URLSearchParams({
      projectKey,
      testPlanKey,
    }).toString();

    imports.push({
      story: storyKey,
      projectKey,
      testPlanKey,
      endpoint: endpoint.href,
      ...resultReport(rows),
    });
  }
  return { tenant, imports, skipped, notPublished };
}

type ImportGroup = Awaited<
  ReturnType<typeof prepareStoryResults>
>["imports"][number];

async function recordExecution(
  root: string,
  group: ImportGroup,
  executionKey: string,
) {
  const { file, feature, source } = await loadFeature(root, group.story);
  if (feature.testPlanKey !== group.testPlanKey)
    throw new Error(`Test Plan changed for ${group.story} while importing`);
  const temp = resolve(dirname(file), `.${randomUUID()}.tmp`);
  try {
    await writeFile(
      temp,
      JSON.stringify({ ...feature, testExecutionKey: executionKey }, null, 2) +
        "\n",
      { flag: "wx" },
    );
    if ((await readFile(file, "utf8")) !== source)
      throw new Error(
        `Feature record changed for ${group.story} while importing`,
      );
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

async function post(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: string,
) {
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim();
    throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  return (await response.json()) as unknown;
}

export async function importStoryResults(options: ResultsOptions) {
  const { env, root, fetch: fetcher = fetch, print = console.log } = options;
  const preview = await prepareStoryResults(options);
  if (options.dryRun) {
    print(JSON.stringify(preview, null, 2));
    return { preview };
  }
  if (!preview.imports.length) {
    print(JSON.stringify(preview, null, 2));
    return { executions: [] };
  }

  const clientId = env.XRAY_CLIENT_ID?.trim();
  const clientSecret = env.XRAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("Xray credentials are required for live import");

  const executions = [];
  let token: string | undefined;
  for (const group of preview.imports) {
    let executionKey: string | undefined;
    try {
      if (!token) {
        const auth = new URL("/api/v2/authenticate", group.endpoint);
        token = z
          .string()
          .regex(/^[A-Za-z0-9._~-]+$/)
          .parse(
            await post(
              fetcher,
              auth.href,
              { "Content-Type": "application/json" },
              JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
              }),
            ),
          );
      }

      const response = await post(
        fetcher,
        group.endpoint,
        {
          "Content-Type": "text/xml",
          Authorization: `Bearer ${token}`,
        },
        group.payload,
      );
      executionKey = z.object({ key }).parse(response).key;
      if (!executionKey.startsWith(group.projectKey + "-"))
        throw new Error(
          "Xray returned a Test Execution key outside the target project",
        );
      await recordExecution(root, group, executionKey);
      executions.push({ story: group.story, testExecutionKey: executionKey });
      print(`${group.story}: Test Execution ${executionKey}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = [clientId, clientSecret, token].reduce<string>(
        (text, secret) =>
          secret ? text.replaceAll(secret, "[redacted]") : text,
        message,
      );
      throw new Error(
        `Xray import stopped at ${group.story}${executionKey ? ` (returned ${executionKey})` : ""}: ${detail}`,
      );
    }
  }
  return { executions };
}
