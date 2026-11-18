import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, readFile, writeFile, lstat } from "node:fs/promises";
import {
  resolve,
  relative,
  isAbsolute,
  dirname,
  basename,
  sep,
} from "node:path";
import { safeId, storyKey } from "./contracts/index.js";

export function fingerprint(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("Non-JSON value");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const objectDigest = (value: unknown) => fingerprint(canonical(value));
export function within(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(resolve(root), target);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Path outside artifact root");
  return target;
}
export async function noSymlinks(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new Error("Path escape");
  let current = root;
  for (const part of ["", ...rel.split(/[\\/]/).filter(Boolean)]) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error("Symlink artifacts are forbidden");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
export function sanitized(value: unknown): string {
  const inspect = (item: unknown): void => {
    if (Array.isArray(item)) return item.forEach(inspect);
    if (item && typeof item === "object")
      for (const [key, child] of Object.entries(item)) {
        if (
          /password|client.?secret|access.?token|authorization|cookie|credential/i.test(
            key,
          )
        )
          throw new Error("Sensitive artifact field rejected");
        inspect(child);
      }
  };
  inspect(value);
  const body = JSON.stringify(value, null, 2);
  if (
    /Bearer\s+\S+|-----BEGIN .*PRIVATE KEY|https?:\/\/[^\s/]+:[^\s/]+@/i.test(
      body,
    )
  )
    throw new Error("Sensitive artifact content rejected");
  return body + "\n";
}
export async function writeExclusive(
  root: string,
  path: string,
  value: unknown,
): Promise<string> {
  const target = within(root, path);
  const body = sanitized(value);
  await noSymlinks(root, target);
  await mkdir(dirname(target), { recursive: true });
  await noSymlinks(root, target);
  await writeFile(target, body, { flag: "wx" });
  return fingerprint(body);
}

export async function writeTextExclusive(
  root: string,
  path: string,
  text: string,
): Promise<string> {
  sanitized({ content: text });
  const target = within(root, path);
  await noSymlinks(root, target);
  await mkdir(dirname(target), { recursive: true });
  await noSymlinks(root, target);
  await writeFile(target, text, { flag: "wx" });
  return fingerprint(text);
}
export async function verifyRepository(root: string): Promise<string> {
  const actual = await realpath(root);
  const pkg = JSON.parse(
    await readFile(resolve(actual, "package.json"), "utf8"),
  );
  if (
    basename(actual) !== "agentic-demo-website" ||
    pkg.name !== "agentic-demo-website"
  )
    throw new Error("Unauthorized repository");
  return actual;
}
export async function createRun(
  root: string,
  key: string,
): Promise<{ path: string; runId: string }> {
  storyKey.parse(key);
  const actual = await verifyRepository(root);
  const parent = within(actual, `artifacts/qa/${key}`);
  await noSymlinks(actual, parent);
  await mkdir(parent, { recursive: true });
  const runId = `run-${Date.now()}-${randomUUID()}`;
  safeId.parse(runId);
  const path = within(parent, runId);
  await noSymlinks(actual, path);
  await mkdir(path); // exclusive: never reuse or overwrite another run
  for (const folder of [
    "source",
    "requirements",
    "design",
    "implementation",
    "automation",
    "executions",
    "xray",
    "approvals",
    "audit",
    "delivery",
    "state",
  ])
    await mkdir(resolve(path, folder));
  return { path, runId };
}
