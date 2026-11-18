import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stateSchema, type WorkflowState } from "./contracts/index.js";
import { noSymlinks, writeExclusive } from "./artifacts.js";

export async function saveState(root: string, state: WorkflowState) {
  stateSchema.parse(state);
  // Exclusive sequence files provide single-winner optimistic concurrency.
  await writeExclusive(
    root,
    `state/${String(state.sequence).padStart(8, "0")}.json`,
    state,
  );
}
export async function loadState(root: string): Promise<WorkflowState> {
  const directory = resolve(root, "state");
  await noSymlinks(root, directory);
  const names = (await readdir(directory))
    .filter((name) => /^\d{8}\.json$/.test(name))
    .sort();
  if (!names.length) throw new Error("No workflow state");
  let state: WorkflowState | undefined;
  for (const [index, name] of names.entries()) {
    const path = resolve(directory, name);
    await noSymlinks(root, path);
    const next = stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (
      next.sequence !== index ||
      (state &&
        (next.storyKey !== state.storyKey || next.runId !== state.runId))
    )
      throw new Error("Invalid state history");
    state = next;
  }
  return state!;
}
