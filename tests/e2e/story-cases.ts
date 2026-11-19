import { readFileSync } from "node:fs";
import type { TestDetails } from "@playwright/test";
import { z } from "zod";

const issueKey = z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/);
const caseId = z.string().regex(/^[A-Z][A-Z0-9-]*-TC-\d+$/);
const mappingSchema = z.record(caseId, issueKey);

function forStory(story: string) {
  issueKey.parse(story);
  let keys: Record<string, string> = {};
  try {
    keys = mappingSchema.parse(
      JSON.parse(
        readFileSync(`artifacts/qa/${story}/xray-test-keys.json`, "utf8"),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return (title: string): TestDetails => {
    const match = /^([A-Z][A-Z0-9-]*-TC-)(\d+(?:\/\d+)*):/.exec(title);
    if (!match?.[2]) throw new Error(`Missing case ID prefix on ${title}`);
    const cases = match[2].split("/").map((id) => match[1] + id);
    const published = cases.filter((id) => Object.hasOwn(keys, id));
    return {
      tag: [
        `@${story}`,
        ...cases.map((id) => `@${id}`),
        ...published.map((id) => `@${keys[id]}`),
      ],
      annotation: [
        { type: "story", description: story },
        ...cases.map((id) => ({ type: "case_id", description: id })),
        ...published.map((id) => ({
          type: "published_case",
          description: `${id}=${keys[id]}`,
        })),
      ],
    };
  };
}

export const taskCaseDetails = forStory("KAN-25");
