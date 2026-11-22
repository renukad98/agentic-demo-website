import type { z } from "zod";
import type {
  caseImplementationSchema,
  coverageMapping,
  requirementsSchema,
  scenariosSchema,
  traceabilitySchema,
  Identity,
  WorkflowInput,
} from "./contracts/index.js";

type Cases = z.infer<typeof scenariosSchema>["scenarios"];
type Mapping = z.infer<typeof coverageMapping>;
type Rows = z.infer<typeof traceabilitySchema>["rows"];
type Requirements = z.infer<typeof requirementsSchema>["requirements"];

export function validateCaseImplementation(
  cases: Cases,
  proof: z.infer<typeof caseImplementationSchema>,
  browserHandoff?: string[],
) {
  const browser = browserHandoff !== undefined;
  const expected = new Set<string>();
  const browserCases: string[] = [];
  const caseIds = new Set<string>();
  for (const scenario of cases) {
    if (caseIds.has(scenario.id)) throw new Error("Duplicate approved case ID");
    caseIds.add(scenario.id);
    if (scenario.kind === "audit") {
      if (scenario.levels) throw new Error("Audit case has automation levels");
      continue;
    }
    const levels = scenario.levels;
    if (!levels?.length || new Set(levels).size !== levels.length)
      throw new Error(
        "Approved case requires distinct automation levels: " + scenario.id,
      );
    if (levels.includes("browser")) browserCases.push(scenario.id);
    for (const level of levels)
      if ((level === "browser") === browser)
        expected.add(JSON.stringify([scenario.id, level]));
  }
  const handoff = browserHandoff ?? proof.browserCases;
  if (
    new Set(handoff).size !== handoff.length ||
    handoff.length !== browserCases.length ||
    !browserCases.every((id) => handoff.includes(id)) ||
    (browser && proof.browserCases.length)
  )
    throw new Error("Browser handoff must match the approved browser cases");
  const covered = new Set<string>();
  const mappings = new Set<string>();
  for (const mapping of proof.mappings) {
    const level = JSON.stringify([mapping.caseId, mapping.level]);
    const key = JSON.stringify([mapping.caseId, mapping.automationIdentity]);
    if (!expected.has(level) || !Object.hasOwn(proof.files, mapping.file))
      throw new Error("Invalid case mapping or missing test file evidence");
    if (mappings.has(key)) throw new Error("Duplicate case mapping");
    mappings.add(key);
    covered.add(level);
  }
  if (covered.size !== expected.size)
    throw new Error("Missing approved case coverage");
}

export function validateFinalMappings(
  input: WorkflowInput,
  mappings: Mapping[],
  identities: Identity[],
  rows: Rows,
  cases: Cases,
  requirements: Requirements,
) {
  const inventory = new Map(
    identities.map((item) => [
      [item.repository, item.runner, item.automationId].join(":"),
      item,
    ]),
  );
  if (inventory.size !== identities.length)
    throw new Error("Duplicate automation inventory identity");
  const byIdentity = new Map<string, Mapping>();
  const mapped = new Map<string, Mapping>();
  const claims = new Set<string>();
  for (const mapping of mappings) {
    const previous = byIdentity.get(mapping.automationIdentity);
    if (
      previous &&
      (previous.file !== mapping.file || previous.title !== mapping.title)
    )
      throw new Error(
        "Conflicting exact test path or title for automation identity: " +
          mapping.automationIdentity,
      );
    byIdentity.set(mapping.automationIdentity, mapping);
    const key = JSON.stringify([mapping.caseId, mapping.automationIdentity]);
    if (mapped.has(key)) throw new Error("Duplicate case mapping");
    mapped.set(key, mapping);
    for (const { requirementId, acceptanceId } of mapping.covers) {
      const claim = JSON.stringify([
        mapping.caseId,
        requirementId,
        acceptanceId,
        mapping.automationIdentity,
      ]);
      if (claims.has(claim))
        throw new Error("Duplicate implementation coverage claim");
      claims.add(claim);
    }
  }
  const used = new Set<string>();
  const caseCoverage = new Set<string>();
  const rowKeys = new Set<string>();
  for (const row of rows) {
    const key = JSON.stringify([
      row.scenarioId,
      row.requirementId,
      row.acceptanceId,
      row.automationIdentity,
    ]);
    if (rowKeys.has(key)) throw new Error("Duplicate traceability mapping");
    rowKeys.add(key);
    const pair = JSON.stringify([
      row.scenarioId,
      row.requirementId,
      row.acceptanceId,
    ]);
    caseCoverage.add(pair);
    if (!row.automationIdentity) {
      if (
        !cases.some(
          (scenario) =>
            scenario.id === row.scenarioId && scenario.kind === "audit",
        )
      )
        throw new Error("Missing automation identity for approved case");
      continue;
    }
    if (!claims.delete(key))
      throw new Error("Unsupported traceability coverage claim");
    const item = inventory.get(row.automationIdentity);
    const mapping = mapped.get(
      JSON.stringify([row.scenarioId, row.automationIdentity]),
    );
    if (
      !mapping ||
      !item ||
      item.repository !== input.repository.namespace ||
      item.sourceDigest !== input.sourceDigest ||
      item.sourceLocation !== mapping.file ||
      (item.binding && item.binding.testTitle !== mapping.title) ||
      item.runner !== (mapping.level === "browser" ? "playwright" : "node") ||
      !item.associations.some(
        (association) =>
          association.storyKey === input.storyKey &&
          association.scenarioIds.includes(row.scenarioId) &&
          association.requirementIds.includes(row.requirementId) &&
          association.acceptanceIds.includes(row.acceptanceId),
      )
    )
      throw new Error("Invalid automation identity or case association");
    used.add(row.automationIdentity);
  }
  if (claims.size)
    throw new Error("Missing traceability for implementation coverage claim");
  if (used.size !== inventory.size)
    throw new Error("Unmapped automation inventory identity");
  for (const scenario of cases) {
    const related = requirements
      .filter((requirement) => scenario.requirementIds.includes(requirement.id))
      .flatMap((requirement) =>
        requirement.acceptanceIds
          .filter((id) => scenario.acceptanceIds.includes(id))
          .map((id) => [requirement.id, id] as const),
      );
    if (
      !related.length ||
      scenario.requirementIds.some(
        (id) => !related.some(([req]) => req === id),
      ) ||
      scenario.acceptanceIds.some(
        (id) => !related.some(([, criterion]) => criterion === id),
      )
    )
      throw new Error("Incomplete approved case relations");
    for (const [requirement, acceptance] of related)
      if (
        !caseCoverage.has(
          JSON.stringify([scenario.id, requirement, acceptance]),
        )
      )
        throw new Error("Missing approved case traceability");
  }
}
