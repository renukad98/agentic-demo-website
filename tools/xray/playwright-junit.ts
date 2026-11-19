import { JSDOM } from "jsdom";

export const rawJUnitReport = ".test-results/playwright-junit.xml";
export const storyJUnitReport = ".test-results/xray-junit.xml";
export const issueKey = /^[A-Z][A-Z0-9]*-\d+$/;
export const caseId = /^[A-Z][A-Z0-9-]*-TC-\d+$/;

export function parseJUnit(xml: string) {
  if (/<!DOCTYPE/i.test(xml))
    throw new Error("JUnit must not contain a DOCTYPE");
  const document = new JSDOM(xml, { contentType: "text/xml" }).window.document;
  if (!["testsuite", "testsuites"].includes(document.documentElement.tagName))
    throw new Error("Expected a JUnit testsuite or testsuites root");
  return document;
}

export function propertyValues(test: Element, name: string) {
  return [...test.querySelectorAll(":scope > properties > property")]
    .filter((property) => property.getAttribute("name") === name)
    .map((property) => property.getAttribute("value") ?? "");
}

export function addProperty(test: Element, name: string, value: string) {
  const document = test.ownerDocument;
  let properties = test.querySelector(":scope > properties");
  if (!properties) {
    properties = document.createElement("properties");
    test.prepend(properties);
  }
  const property = document.createElement("property");
  property.setAttribute("name", name);
  property.setAttribute("value", value);
  properties.append(property);
}

export function junitOutcome(
  test: Element,
): "error" | "failure" | "skipped" | "passed" {
  if (test.querySelector(":scope > error")) return "error";
  if (test.querySelector(":scope > failure")) return "failure";
  if (test.querySelector(":scope > skipped")) return "skipped";
  return "passed";
}

export function summarizeJUnit(root: Element) {
  const tests = [...root.querySelectorAll("testcase")];
  const outcomes = tests.map(junitOutcome);
  root.setAttribute("tests", String(tests.length));
  for (const [attribute, outcome] of [
    ["failures", "failure"],
    ["errors", "error"],
    ["skipped", "skipped"],
  ] as const) {
    root.setAttribute(
      attribute,
      String(outcomes.filter((value) => value === outcome).length),
    );
  }
}

export function expandPlaywrightJUnit(xml: string) {
  const document = parseJUnit(xml);
  const notPublished: string[] = [];
  for (const test of [...document.querySelectorAll("testcase")]) {
    const stories = propertyValues(test, "story");
    const title = test.getAttribute("name");
    if (stories.length !== 1 || !issueKey.test(stories[0] ?? ""))
      throw new Error(`Missing or invalid story on Playwright test ${title}`);
    const cases = propertyValues(test, "case_id");
    if (
      !cases.length ||
      cases.some((id) => !caseId.test(id)) ||
      new Set(cases).size !== cases.length
    )
      throw new Error(
        `Missing or invalid case IDs on Playwright test ${title}`,
      );
    const keys = new Map<string, string>();
    for (const mapping of propertyValues(test, "published_case")) {
      const [id, key, extra] = mapping.split("=");
      if (
        !id ||
        !key ||
        !cases.includes(id) ||
        !issueKey.test(key) ||
        extra !== undefined ||
        keys.has(id)
      )
        throw new Error(
          `Invalid published case mapping on Playwright test ${title}`,
        );
      keys.set(id, key);
    }
    for (const id of cases) {
      const result = test.cloneNode(true) as Element;
      for (const property of result.querySelectorAll(
        ':scope > properties > property[name="case_id"], :scope > properties > property[name="published_case"]',
      ))
        property.remove();
      result.setAttribute("name", `${title} [${id}]`);
      addProperty(result, "case_id", id);
      const key = keys.get(id);
      if (key) addProperty(result, "test_key", key);
      else {
        addProperty(result, "publication", "not published");
        notPublished.push(`${stories[0]} ${id}: not published (${title})`);
      }
      test.before(result);
    }
    test.remove();
  }
  for (const suite of document.querySelectorAll("testsuites, testsuite"))
    summarizeJUnit(suite);
  return { xml: document.documentElement.outerHTML + "\n", notPublished };
}
