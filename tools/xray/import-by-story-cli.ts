import { parseArgs } from "node:util";
import { config } from "dotenv";
import { importStoryResults } from "./import-by-story.js";

try {
  const { values } = parseArgs({
    options: {
      "qa-run": { type: "boolean" },
      "dry-run": { type: "boolean" },
      report: { type: "string" },
      story: { type: "string" },
    },
  });
  config({ quiet: true });
  await importStoryResults({
    root: process.cwd(),
    env: process.env,
    report: values.report,
    story: values.story,
    dryRun: values["dry-run"],
    qaRun: values["qa-run"],
  });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Xray results import failed",
  );
  process.exitCode = 1;
}
