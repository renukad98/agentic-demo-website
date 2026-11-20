import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  importStoryResults,
  prepareStoryResults,
} from "../../tools/xray/import-by-story.js";
import {
  expandPlaywrightJUnit,
  junitOutcome,
  parseJUnit,
  propertyValues,
} from "../../tools/xray/playwright-junit.js";

const env = {
  JIRA_BASE_URL: "https://jira.example.test",
  XRAY_BASE_URL: "https://xray.example.test",
  XRAY_CLIENT_ID: "synthetic-id",
  XRAY_CLIENT_SECRET: "synthetic-secret",
};

function raw(story: string, status = "") {
  return `<testcase name="A &amp; B"><properties>
    <property name="story" value="${story}"/>
    <property name="case_id" value="TM-TC-05"/>
    <property name="case_id" value="TM-TC-10"/>
    <property name="published_case" value="TM-TC-05=${story.split("-")[0]}-32"/>
  </properties>${status}</testcase>`;
}

async function fixture(t: TestContext, stories = ["KAN-25"]) {
  const root = await mkdtemp(join(tmpdir(), "xray-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const save = async (path: string, value: string | object) => {
    const file = join(root, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const report = ".test-results/xray-junit.xml";
  const setReport = (rows: string) =>
    save(report, `<testsuites><testsuite>${rows}</testsuite></testsuites>`);
  for (const storyKey of stories) {
    const project = storyKey.split("-")[0];
    await save(`qa/${storyKey}/feature.json`, {
      storyKey,
      stage: "published",
      testPlanKey: `${project}-35`,
      title: "Demo",
    });
    await save(`artifacts/qa/${storyKey}/xray-test-keys.json`, {
      "TM-TC-05": `${project}-32`,
    });
  }
  await save(
    report,
    expandPlaywrightJUnit(
      `<testsuite>${stories.map((story) => raw(story)).join("")}</testsuite>`,
    ).xml,
  );
  const calls: { url: string; request?: RequestInit | undefined }[] = [];
  const output: string[] = [];
  const fetcher: typeof fetch = async (url, request) => {
    calls.push({ url: String(url), request });
    const project = new URL(String(url)).searchParams.get("projectKey");
    return Response.json(project ? { key: `${project}-99` } : "fixture-token");
  };
  return {
    root,
    report,
    save,
    setReport,
    calls,
    output,
    options: {
      root,
      env,
      fetch: fetcher,
      print: (line: string) => output.push(line),
    },
  };
}

test("JUnit expands each case, preserves failure, and lists unpublished cases", () => {
  const report = expandPlaywrightJUnit(
    `<testsuite>${raw("KAN-25", "<failure>error &amp; details</failure>")}</testsuite>`,
  );
  const tests = [...parseJUnit(report.xml).querySelectorAll("testcase")];
  assert.equal(tests.length, 2);
  assert.deepEqual(tests.map(junitOutcome), ["failure", "failure"]);
  assert.deepEqual(propertyValues(tests[0]!, "test_key"), ["KAN-32"]);
  assert.deepEqual(propertyValues(tests[1]!, "publication"), ["not published"]);
  assert.match(report.notPublished[0]!, /TM-TC-10: not published/);
});

test("dry run groups by story and filters exact story without fetching", async (t) => {
  const f = await fixture(t, ["KAN-25", "QA-1"]);
  const preview = await prepareStoryResults(f.options);
  assert.deepEqual(
    preview.imports.map(({ story, testPlanKey }) => [story, testPlanKey]),
    [
      ["KAN-25", "KAN-35"],
      ["QA-1", "QA-35"],
    ],
  );
  assert.equal(preview.notPublished.length, 2);
  const filtered = await prepareStoryResults({ ...f.options, story: "QA-1" });
  assert.equal(filtered.imports.length, 1);
  assert.deepEqual(
    filtered.notPublished.map(({ story }) => story),
    ["QA-1"],
  );
  await importStoryResults({ ...f.options, dryRun: true, env: {} });
  assert.deepEqual(
    JSON.parse(f.output[0]!),
    await prepareStoryResults({ ...f.options, env: {} }),
  );
  assert.equal(f.calls.length, 0);
});

test("done, paused and no-plan stories are reported and a missing story fails before fetch", async (t) => {
  const f = await fixture(t, ["KAN-25", "QA-1", "ZZ-1"]);
  await f.save("qa/ZZ-1/feature.json", {
    storyKey: "ZZ-1",
    stage: "published",
    testPlanKey: "ZZ-35",
    paused: true,
  });
  await f.save("qa/KAN-25/feature.json", { storyKey: "KAN-25", stage: "done" });
  await f.save("qa/QA-1/feature.json", {
    storyKey: "QA-1",
    stage: "published",
  });
  assert.deepEqual((await prepareStoryResults(f.options)).skipped, [
    { story: "KAN-25", reason: "story done" },
    { story: "QA-1", reason: "no testPlanKey" },
    { story: "ZZ-1", reason: "story paused" },
  ]);
  await f.setReport('<testcase name="untagged"/>');
  await assert.rejects(
    importStoryResults({ ...f.options, story: "KAN-25" }),
    /Missing or invalid story/,
  );
  assert.equal(f.calls.length, 0);
});

test("a changed mapping blocks import before fetch", async (t) => {
  const f = await fixture(t);
  await f.save("artifacts/qa/KAN-25/xray-test-keys.json", {
    "TM-TC-05": "KAN-90",
  });
  await assert.rejects(importStoryResults(f.options), /mapping changed/);
  assert.equal(f.calls.length, 0);
});

test("invalid or unmarked missing Test keys block import before fetch", async (t) => {
  const f = await fixture(t);
  for (const testKey of ["", '<property name="test_key" value="invalid"/>']) {
    await f.setReport(`<testcase name="invalid"><properties>
      <property name="story" value="KAN-25"/>
      <property name="case_id" value="TM-TC-05"/>
      ${testKey}</properties></testcase>`);
    await assert.rejects(
      importStoryResults(f.options),
      /Missing or invalid test_key/,
    );
  }
  assert.equal(f.calls.length, 0);
});

test("direct import posts exactly the previewed XML and persists the execution", async (t) => {
  const f = await fixture(t, ["KAN-25", "QA-1"]);
  const preview = await prepareStoryResults(f.options);
  const result = await importStoryResults(f.options);
  assert.deepEqual(result.executions, [
    { story: "KAN-25", testExecutionKey: "KAN-99" },
    { story: "QA-1", testExecutionKey: "QA-99" },
  ]);
  assert.equal(
    f.calls[0]?.url,
    "https://xray.example.test/api/v2/authenticate",
  );
  for (const [index, group] of preview.imports.entries()) {
    const request = f.calls[index + 1]!;
    assert.equal(request.url, group.endpoint);
    assert.equal(request.request?.method, "POST");
    assert.equal(request.request?.body, group.payload);
    assert.doesNotMatch(group.payload, /TM-TC-10/);
    assert.equal(
      new URL(request.url).searchParams.get("testPlanKey"),
      group.testPlanKey,
    );
    const feature = JSON.parse(
      await readFile(join(f.root, "qa", group.story, "feature.json"), "utf8"),
    );
    assert.equal(feature.testExecutionKey, group.projectKey + "-99");
    assert.equal(feature.title, "Demo");
  }
  assert.equal(f.calls.length, 3);
  assert.deepEqual(
    (await importStoryResults(f.options)).executions,
    result.executions,
  );
  assert.equal(f.calls.length, 6);
});

test("import stops at the first Xray error and shows its response text", async (t) => {
  const f = await fixture(t, ["KAN-25", "QA-1", "ZZ-1"]);
  const fetcher: typeof fetch = async (url, request) => {
    if (new URL(String(url)).searchParams.get("projectKey") === "QA")
      return new Response("Invalid Test Plan (synthetic-secret)", {
        status: 502,
      });
    return f.options.fetch(url, request);
  };
  await assert.rejects(
    importStoryResults({ ...f.options, fetch: fetcher }),
    /stopped at QA-1.*HTTP 502: Invalid Test Plan \(\[redacted\]\)/,
  );
  assert.deepEqual(f.output, ["KAN-25: Test Execution KAN-99"]);
  assert(!f.calls.some(({ url }) => url.includes("ZZ-35")));
});

test("import combines repeated observations for the same Test key without masking failure", async (t) => {
  const f = await fixture(t);
  await f.save(
    f.report,
    expandPlaywrightJUnit(
      `<testsuite>${raw("KAN-25")}${raw("KAN-25", "<failure/>")}</testsuite>`,
    ).xml,
  );
  const [group] = (await prepareStoryResults(f.options)).imports;
  assert(group);
  assert.deepEqual(
    group.observations.map(({ outcome }) => outcome),
    ["passed", "failure"],
  );
  const tests = [...parseJUnit(group.payload).querySelectorAll("testcase")];
  assert.deepEqual(tests.map(junitOutcome), ["failure"]);
});
