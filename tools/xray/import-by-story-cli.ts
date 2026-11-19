import { parseArgs } from "node:util";
import { config } from "dotenv";
import { importStoryResults } from "./import-by-story.js";

try {
  const { values } = parseArgs({
    options: {
      "dry-run": { type: "boolean" },
      confirm: { type: "string" },
      report: { type: "string" },
      story: { type: "string" },
    },
  });
  if (values["dry-run"] && values.confirm !== undefined)
    throw new Error("Use either --dry-run or --confirm, not both");
  config({ quiet: true });
  await importStoryResults(
    {
      root: process.cwd(),
      env: process.env,
      report: values.report,
      story: values.story,
    },
    values.confirm,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Xray results import failed",
  );
  process.exitCode = 1;
}
