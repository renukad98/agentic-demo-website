import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { noSymlinks, objectDigest, within } from "../agentic/artifacts.js";
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
    if (ids.length !== 1 || !caseId.test(ids[0] ?? ""))
      throw new Error(`Missing or invalid case ID on JUnit test ${name}`);
    const keys = propertyValues(test, "test_key");
    const publication = propertyValues(test, "publication");
    if (
      !keys.length &&
      publication.length === 1 &&
      publication[0] === "not published"
    ) {
      if (!story || story === storyKey)
        notPublished.push({ story: storyKey, caseId: ids[0]!, test: name });
      continue;
    }
    if (
      keys.length !== 1 ||
      !issueKey.test(keys[0] ?? "") ||
      publication.length
    )
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
      const id = propertyValues(row, "case_id")[0]!;
      if (mapping[id] !== propertyValues(row, "test_key")[0])
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
  const preview = { tenant, imports, skipped, notPublished };
  return { ...preview, digest: objectDigest(preview) };
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
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

export async function importStoryResults(
  options: ResultsOptions,
  confirm?: string,
) {
  const { env, root, fetch: fetcher = fetch, print = console.log } = options;
  const preview = await prepareStoryResults(options);
  if (confirm === undefined) {
    print(JSON.stringify(preview, null, 2));
    return { preview };
  }
  if (confirm !== preview.digest)
    throw new Error(
      "Confirmation does not match the current dry-run payload digest",
    );
  if (env.XRAY_ENABLE_WRITES !== "true")
    throw new Error("Live results import requires XRAY_ENABLE_WRITES=true");
  if (!preview.imports.length) {
    print(JSON.stringify(preview, null, 2));
    return { executions: [] };
  }
  if (!preview.tenant)
    throw new Error("Set JIRA_BASE_URL and regenerate the dry-run preview");
  const clientId = env.XRAY_CLIENT_ID?.trim();
  const clientSecret = env.XRAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("Xray credentials are required for live import");
  const executions = [];
  let token: string | undefined;
  for (const group of preview.imports) {
    const directory = await safePath(
      root,
      `artifacts/qa/${group.story}/xray-results`,
    );
    await mkdir(directory, { recursive: true });
    const reservation = resolve(directory, "pending.json");
    await writeFile(
      reservation,
      JSON.stringify({
        digest: preview.digest,
        groupDigest: objectDigest(group),
        testPlanKey: group.testPlanKey,
      }),
      { flag: "wx" },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST")
        throw new Error(
          `Pending import for ${group.story}; reconcile it before retrying`,
        );
      throw error;
    });
    const receipt = resolve(
      directory,
      `${objectDigest({ tenant: preview.tenant, group }).slice(7)}.json`,
    );
    let dispatched = false;
    let executionKey: string | undefined;
    try {
      const previous = await readFile(receipt, "utf8").catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      if (previous !== undefined) {
        const saved = z
          .object({ testExecutionKey: key })
          .parse(JSON.parse(previous));
        throw new Error(
          `Results already imported as ${saved.testExecutionKey}`,
        );
      }

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
      if ((await prepareStoryResults(options)).digest !== preview.digest)
        throw new Error("Preview changed before dispatch");

      dispatched = true;
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
      await writeFile(
        receipt,
        JSON.stringify({
          story: group.story,
          testPlanKey: group.testPlanKey,
          testExecutionKey: executionKey,
        }),
        { flag: "wx" },
      );
      await recordExecution(root, group, executionKey);
      executions.push({ story: group.story, testExecutionKey: executionKey });
      print(`${group.story}: Test Execution ${executionKey}`);
      await rm(reservation);
    } catch (error) {
      if (!dispatched) await rm(reservation);
      const message =
        error instanceof Error && /^HTTP \d+$/.test(error.message)
          ? error.message
          : undefined;
      if (
        !dispatched &&
        error instanceof Error &&
        /^(?:Results already imported|Preview changed)/.test(error.message)
      )
        throw error;
      if (!dispatched)
        throw new Error(
          `Xray authentication or local import preparation failed for ${group.story}${message ? ` (${message})` : ""}`,
        );
      throw new Error(
        `Xray import stopped at ${group.story}${executionKey ? ` (returned ${executionKey})` : ""}${message ? ` (${message})` : ""}; reconcile the pending import before retrying. Remaining stories were not attempted.`,
      );
    }
  }
  return { executions };
}
