import type { Reporter } from "@playwright/test/reporter";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  expandPlaywrightJUnit,
  rawJUnitReport,
  storyJUnitReport,
} from "./playwright-junit.js";

export default class XrayJUnitReporter implements Reporter {
  printsToStdio() {
    return true;
  }

  async onEnd() {
    await rm(storyJUnitReport, { force: true });
    try {
      const expanded = expandPlaywrightJUnit(
        await readFile(rawJUnitReport, "utf8"),
      );
      await writeFile(storyJUnitReport, expanded.xml);
      for (const item of expanded.notPublished) console.log(item);
    } catch (error) {
      console.error(error);
      return { status: "failed" as const };
    }
  }
}
