import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { fingerprint, noSymlinks, objectDigest, within } from "./artifacts.js";
import { digest, storyKey } from "./contracts/index.js";

const featureProgress = z.object({
  storyKey,
  stage: z.string(),
  paused: z.boolean().optional(),
  completedStages: z.array(z.string()),
  pendingStages: z.array(z.string()),
  evidence: z.record(z.string(), z.unknown()).optional(),
});
type FeatureProgress = z.infer<typeof featureProgress>;
const evidenceRef = z.object({ path: z.string(), digest }).strict();
const routingProof = z
  .object({
    storyKey,
    kind: z.enum(["feature-development", "agent-06", "legacy-equivalent"]),
    design: evidenceRef,
    designReview: evidenceRef,
    coverageReview: evidenceRef,
    caseMappings: evidenceRef,
    sourceFiles: z
      .record(z.string(), digest)
      .refine((files) => Object.keys(files).length > 0),
  })
  .strict();

const commands: Record<string, string> = {
  story: "qa story",
  requirements: "qa requirements",
  designed: "qa test-design",
  reviewed: "qa test-review",
  "branch-ready": "qa branch",
  implemented: "qa implement",
  automated: "qa e2e",
  executed: "qa run",
  published: "qa xray",
  "in-review": "qa pr",
  done: "qa close",
};
const caseStage = "tests-implemented";
const downstream = new Set(["automated", "executed", "in-review", "done"]);

export function isStoryPaused(
  feature: Pick<FeatureProgress, "storyKey" | "stage" | "paused">,
) {
  return (
    feature.paused === true ||
    feature.stage === "paused" ||
    ["KAN-29", "KAN-30"].includes(feature.storyKey)
  );
}

export async function assertStoryUnpaused(root: string, key: string) {
  if (isStoryPaused({ storyKey: key, stage: "" }))
    throw new Error(key + " is paused");
  const path = within(root, "qa/" + key + "/feature.json");
  await noSymlinks(root, path);
  const record = await readFile(path, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  if (record === undefined) return;
  const feature = z
    .object({ storyKey, stage: z.string(), paused: z.boolean().optional() })
    .parse(JSON.parse(record));
  if (feature.storyKey !== key)
    throw new Error("Feature record Story mismatch");
  if (isStoryPaused(feature)) throw new Error(key + " is paused");
}

async function readLocal(root: string, path: string) {
  const target = within(root, path);
  await noSymlinks(root, target);
  return readFile(target);
}

export function hasAcceptedDesignReview(review: string, designDigest: string) {
  return (
    /^- (?:Decision|Review decision): accepted(?: for design)?(?:[.\r]|$)/im.test(
      review,
    ) && review.includes("testDesign " + designDigest.slice(7))
  );
}

async function verifyImplementation(root: string, feature: FeatureProgress) {
  const refs = feature.evidence;
  if (typeof refs?.testImplementation !== "string") return false;
  const prefix = "artifacts/qa/" + feature.storyKey + "/";
  const inStory = (path: string) =>
    path.startsWith(prefix) &&
    !path.includes("\\") &&
    !path.split("/").includes("..");
  try {
    if (!inStory(refs.testImplementation)) return false;
    const proof = routingProof.parse(
      JSON.parse(
        (await readLocal(root, refs.testImplementation)).toString("utf8"),
      ),
    );
    if (
      proof.storyKey !== feature.storyKey ||
      proof.design.path !== refs.testDesign ||
      proof.designReview.path !== refs.testReview
    )
      return false;
    const readReviewed = async (ref: z.infer<typeof evidenceRef>) => {
      if (!inStory(ref.path))
        throw new Error("Review evidence must belong to the Story");
      const body = await readLocal(root, ref.path);
      if (fingerprint(body) !== ref.digest)
        throw new Error("Stale review evidence");
      return body.toString("utf8");
    };
    const { coverageReview: reviewRef, ...reviewedRevision } = proof;
    const [, designReview, coverageReview] = await Promise.all([
      readReviewed(proof.design),
      readReviewed(proof.designReview),
      readReviewed(reviewRef),
      readReviewed(proof.caseMappings),
    ]);
    if (
      !hasAcceptedDesignReview(designReview, proof.design.digest) ||
      !/^- Decision: accepted for case implementation\.\r?$/im.test(
        coverageReview,
      ) ||
      !coverageReview
        .split(/\r?\n/)
        .includes(`- Coverage revision: ${objectDigest(reviewedRevision)}`)
    )
      return false;
    for (const [path, expected] of Object.entries(proof.sourceFiles)) {
      if (
        /^(?:artifacts|public\/data)(?:[\\/]|$)|(?:^|[\\/])(?:\.env(?:\..*)?|\.git|data)(?:[\\/]|$)/i.test(
          path,
        ) ||
        fingerprint(await readLocal(root, path)) !== expected
      )
        return false;
    }
    return true;
  } catch {
    // Missing, invalid or unreadable optional proof leaves the QA step pending.
    return false;
  }
}

export async function resolveQaNext(root: string, record: unknown) {
  const feature = featureProgress.parse(record);
  if (
    isStoryPaused(feature) ||
    feature.stage === "done" ||
    feature.completedStages.includes("done")
  )
    return { pendingStages: feature.pendingStages, nextCommand: null };
  const implementationComplete =
    feature.completedStages.includes("implemented");
  const pendingStages = feature.pendingStages.filter(
    (stage) =>
      stage !== caseStage &&
      !(implementationComplete && stage === "implemented"),
  );
  const pendingImplementation = implementationComplete
    ? !(await verifyImplementation(root, feature))
    : feature.pendingStages.includes(caseStage);
  if (pendingImplementation && !pendingStages.includes("implemented")) {
    const index = pendingStages.findIndex((stage) => downstream.has(stage));
    pendingStages.splice(
      index < 0 ? pendingStages.length : index,
      0,
      "implemented",
    );
  }
  return {
    pendingStages,
    nextCommand: commands[pendingStages[0] ?? ""] ?? null,
  };
}

async function main() {
  const root = process.cwd();
  const selected = z
    .object({ storyKey, featureFile: z.string() })
    .parse(
      JSON.parse((await readLocal(root, "qa/current.json")).toString("utf8")),
    );
  if (selected.featureFile !== "qa/" + selected.storyKey + "/feature.json")
    throw new Error("Invalid Story feature record path");
  const feature = featureProgress.parse(
    JSON.parse((await readLocal(root, selected.featureFile)).toString("utf8")),
  );
  if (feature.storyKey !== selected.storyKey)
    throw new Error("Feature record Story mismatch");
  process.stdout.write(
    JSON.stringify(await resolveQaNext(root, feature), null, 2) + "\n",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}
