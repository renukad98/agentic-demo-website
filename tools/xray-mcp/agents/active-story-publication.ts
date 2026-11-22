import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { parseStoryPlan, type StoryPlan } from './contracts/xray-story-publication.js';

const storyKey = z.string().regex(/^[A-Z][A-Z0-9_]{0,9}-[1-9]\d*$/);
const activeRecord = z.object({ storyKey, featureFile: z.string() });
const featureRecord = z.object({
  storyKey,
  paused: z.literal(false),
  stage: z.literal('executed'),
  completedStages: z.array(z.string()),
  evidence: z.object({ reviewedBatchPlan: z.string() }),
});

async function readWithin(directory: string, path: string): Promise<unknown> {
  if (isAbsolute(path)) throw new Error('Expected a repository-relative publication path.');
  const target = await realpath(resolve(directory, path));
  const within = relative(directory, target);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
    throw new Error('Publication evidence must stay within its designated directory.');
  }
  return JSON.parse(await readFile(target, 'utf8'));
}

/** The feature record selects an already reviewed plan. It grants no authority to publish. */
export async function readActiveStoryPublication(projectRoot: string): Promise<StoryPlan> {
  const root = await realpath(projectRoot);
  const active = activeRecord.parse(await readWithin(root, 'qa/current.json'));
  if (active.storyKey === 'KAN-29' || active.storyKey === 'KAN-30') {
    throw new Error('The active Story is paused.');
  }
  if (active.featureFile !== 'qa/' + active.storyKey + '/feature.json') {
    throw new Error('The active feature record does not match the Story.');
  }
  const feature = featureRecord.parse(await readWithin(root, active.featureFile));
  if (feature.storyKey !== active.storyKey ||
      !['reviewed', 'implemented', 'automated', 'executed'].every(stage => feature.completedStages.includes(stage))) {
    throw new Error('The active Story has incomplete QA evidence.');
  }
  const prefix = 'artifacts/qa/' + active.storyKey + '/';
  if (!feature.evidence.reviewedBatchPlan.startsWith(prefix)) {
    throw new Error('The reviewed batch plan must belong to the active Story.');
  }
  const path = await realpath(resolve(root, feature.evidence.reviewedBatchPlan));
  const storyDirectory = resolve(root, prefix);
  const within = relative(storyDirectory, path);
  if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) {
    throw new Error('The reviewed batch plan resolved outside the active Story evidence.');
  }
  const plan = parseStoryPlan(await readWithin(storyDirectory, within));
  if (plan.schemaVersion !== '1.1.0' || plan.storyKey !== active.storyKey) {
    throw new Error('The reviewed plan does not match the active Story.');
  }
  return plan;
}
