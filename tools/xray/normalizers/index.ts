import { JSDOM } from "jsdom";
import { resultSchema, type Result } from "../../agentic/contracts/index.js";
import { fingerprint } from "../../agentic/artifacts.js";

export type IdentityResolver = (
  runner: "node" | "playwright",
  file: string,
  title: string,
  project?: string,
) => string | undefined;
function number(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Invalid result duration");
  return parsed;
}
function timestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid result timestamp");
  return new Date(value).toISOString();
}
export function normalizeNodeXml(
  xml: string,
  artifact: string,
  resolver: IdentityResolver,
): Result[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("XML entities/DTDs forbidden");
  const dom = new JSDOM(xml, { contentType: "text/xml" });
  try {
    const doc = dom.window.document;
    if (!["testsuites", "testsuite"].includes(doc.documentElement.tagName))
      throw new Error("Invalid JUnit root");
    const cases = [...doc.querySelectorAll("testcase")];
    if (!cases.length) throw new Error("No JUnit cases");
    return cases.map((test) => {
      if (test.querySelector("flakyFailure,rerunFailure,rerunError"))
        throw new Error(
          "JUnit retry extension requires explicit attempt mapping",
        );
      const title = test.getAttribute("name");
      if (!title) throw new Error("Missing JUnit case name");
      const file =
        test.getAttribute("file") ?? test.getAttribute("classname") ?? "";
      const identity = resolver("node", file, title);
      if (!identity) throw new Error("Unmapped Node testcase");
      const failures = [...test.querySelectorAll("failure,error")].map(
        (error) =>
          [error.getAttribute("message"), error.textContent]
            .filter(Boolean)
            .join(": "),
      );
      const skip = test.querySelector("skipped");
      const disabled = test.getAttribute("status");
      const outcome = failures.length
        ? "failed"
        : skip
          ? "skipped"
          : disabled && !["run", "passed"].includes(disabled)
            ? "unknown"
            : "passed";
      const duration = number(test.getAttribute("time"));
      return resultSchema.parse({
        identity,
        runner: "node",
        outcome,
        attempt: 0,
        startedAt: timestamp(test.getAttribute("timestamp") ?? undefined),
        durationMs: duration === undefined ? undefined : duration * 1000,
        failures,
        skipReason: skip
          ? (skip.getAttribute("message") ?? skip.textContent ?? "")
          : undefined,
        evidence: [artifact],
        artifactDigest: fingerprint(xml),
      });
    });
  } finally {
    dom.window.close();
  }
}
type Json = Record<string, unknown>;
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Playwright object");
  return value as Json;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Malformed Playwright array");
  return value;
}
export function normalizePlaywrightJson(
  json: string,
  artifact: string,
  resolver: IdentityResolver,
): Result[] {
  const data = object(JSON.parse(json));
  const results: Result[] = [];
  const visit = (raw: unknown, parents: string[]) => {
    const suite = object(raw);
    const titles = [
      ...parents,
      typeof suite.title === "string" ? suite.title : "",
    ].filter(Boolean);
    for (const rawSpec of array(suite.specs ?? [])) {
      const spec = object(rawSpec);
      if (typeof spec.title !== "string" || typeof spec.file !== "string")
        throw new Error("Missing Playwright identity metadata");
      for (const rawTest of array(spec.tests)) {
        const test = object(rawTest);
        const identity = resolver(
          "playwright",
          spec.file,
          [...titles, spec.title].join(" > "),
          typeof test.projectName === "string" ? test.projectName : undefined,
        );
        if (!identity) throw new Error("Unmapped Playwright testcase");
        const attempts = array(test.results);
        if (!attempts.length)
          throw new Error(
            "No Playwright execution attempts; cannot invent results",
          );
        for (const [index, rawAttempt] of attempts.entries()) {
          const attempt = object(rawAttempt);
          const status = attempt.status;
          const outcome =
            status === "passed"
              ? "passed"
              : status === "skipped"
                ? "skipped"
                : ["failed", "timedOut", "interrupted"].includes(String(status))
                  ? "failed"
                  : "unknown";
          const errors = array(
            attempt.errors ?? (attempt.error ? [attempt.error] : []),
          );
          const failures = errors.map((error) => {
            const item = object(error);
            return String(
              item.message ?? item.value ?? "Unspecified execution error",
            );
          });
          const retry = attempt.retry === undefined ? index : attempt.retry;
          results.push(
            resultSchema.parse({
              identity,
              runner: "playwright",
              outcome,
              attempt: retry,
              durationMs: number(attempt.duration),
              startedAt: timestamp(attempt.startTime),
              failures,
              skipReason:
                status === "skipped" ? "Runner reported skipped" : undefined,
              evidence: [
                artifact,
                ...array(attempt.attachments ?? []).flatMap((a) => {
                  const attachment = object(a);
                  return typeof attachment.path === "string"
                    ? [attachment.path]
                    : [];
                }),
              ],
              artifactDigest: fingerprint(json),
            }),
          );
        }
      }
    }
    for (const child of array(suite.suites ?? [])) visit(child, titles);
  };
  for (const suite of array(data.suites)) visit(suite, []);
  if (!results.length) throw new Error("No Playwright test results");
  return results;
}
