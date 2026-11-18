/** Synthetic preparation context, never a production authority/transport. */
import fs from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  jsonFixture,
  fixtureNow,
  syntheticGate,
} from "./json-journal-fixtures.js";
import {
  fixtureSource,
  fixtureReport,
  mockCreation,
} from "../publication-fixtures.js";
import { SyntheticHumanAuthority } from "./human-authority-fixture.js";
import { IdentityRegistry, identityKey } from "../../../tools/xray/identity.js";
import { objectDigest } from "../../../tools/agentic/artifacts.js";
import { TrustedHumanApprovalBoundary } from "../../../tools/agentic/approval-authority.js";
import { OperationJournal } from "../../../tools/xray/operation-journal.js";
import {
  GenericTestCreationAdapter,
  JiraStoryLinkAdapter,
  type CreationPreflight,
  type LinkObservation,
} from "../../../tools/xray/executor-preparation.js";
import assert from "node:assert/strict";

export async function preparationFixture(t: {
  after(fn: () => Promise<void>): void;
}) {
  const root = await fs.mkdtemp(join(tmpdir(), "executor-preparation-")),
    data = jsonFixture();
  for (const [path, body] of [
    [data.identity.sourceLocation, fixtureSource],
    [
      data.identity.binding!.historicalExecutions[0]!.artifactPath,
      fixtureReport,
    ],
  ]) {
    await fs.mkdir(dirname(join(root, path!)), { recursive: true });
    await fs.writeFile(join(root, path!), body!);
  }
  const registry = new IdentityRegistry();
  registry.register(data.identity);
  const context = {
    tenant: data.request.tenant,
    projectKey: "SYN",
    projectId: mockCreation.projectId,
    testIssueTypeId: mockCreation.issueTypeId,
    xrayApiBase: "https://xray.cloud.getxray.app",
    jiraOrigin: "https://synthetic.atlassian.net",
  };
  const journals: OperationJournal[] = [];
  const open = () => {
    const journal = new OperationJournal(root, () => fixtureNow);
    journals.push(journal);
    return journal;
  };
  const journal = open();
  const authority = new SyntheticHumanAuthority(),
    boundary = new TrustedHumanApprovalBoundary(authority, () => fixtureNow);
  const preflight: CreationPreflight = {
    tenant: context.tenant,
    projectKey: context.projectKey,
    storyKey: "SYN-1",
    identity: identityKey(data.identity),
    sourceDigest: data.identity.sourceDigest,
    evidenceDigest: data.proposal.evidenceDigest,
    payloadDigest: data.proposal.payloadDigest,
    xrayApiBase: context.xrayApiBase,
    jiraOrigin: context.jiraOrigin,
    startedAt: fixtureNow - 100,
    checkedAt: fixtureNow,
    complete: true,
    ambiguous: false,
    pages: [{ total: 0, start: 0, ids: [] }],
    candidates: [],
  };
  const request = { ...data.request, preflightDigest: objectDigest(preflight) };
  const input = {
    proposal: data.proposal,
    identity: data.identity,
    approvalRequest: request,
    approvalReference: "create",
  };
  authority.grant("create", request);
  const createAdapter = (approval = boundary, selectedJournal = journal) =>
    new GenericTestCreationAdapter(
      root,
      registry,
      selectedJournal,
      context,
      approval,
      () => fixtureNow,
    );
  const seedConfirmed = async () => {
    const reserved = await journal.consumeAndReserve(
      data.request,
      data.proposal.payload,
      await syntheticGate(data.request).verify("legacy-create", data.request),
    );
    await journal.record({ ...reserved.entry, status: "Attempted" });
    await journal.record({
      ...reserved.entry,
      status: "Confirmed",
      remoteIds: ["101"],
      remoteTestKey: "SYN-2",
    });
  };
  const observation: LinkObservation = {
    preflight: { ...preflight, payloadDigest: data.link.payloadDigest },
    story: {
      key: "SYN-1",
      issueId: "100",
      projectKey: "SYN",
      issueType: "Story",
    },
    test: {
      key: "SYN-2",
      issueId: "101",
      projectKey: "SYN",
      testType: "Generic",
      unstructured: identityKey(data.identity),
    },
    linkType: {
      id: "10037",
      name: "Test",
      inward: "is tested by",
      outward: "tests",
    },
    links: [],
  };
  observation.preflight.pages = [{ total: 1, start: 0, ids: ["101"] }];
  observation.preflight.candidates = [
    {
      key: "SYN-2",
      issueId: "101",
      identity: identityKey(data.identity),
      behaviorDigest: data.identity.behaviorDigest,
      type: "Generic",
    },
  ];
  const linkRequest = {
    ...data.linkRequest,
    preflightDigest: objectDigest(observation),
  };
  const linkInput = {
    proposal: data.link,
    identity: data.identity,
    approvalRequest: linkRequest,
    approvalReference: "link",
  };
  authority.grant("link", linkRequest);
  const linkAdapter = (approval = boundary, selectedJournal = journal) =>
    new JiraStoryLinkAdapter(
      root,
      registry,
      selectedJournal,
      context,
      approval,
      () => fixtureNow,
    );
  t.after(async () => {
    for (const j of journals)
      try {
        await j.close();
      } catch {
        /* fixture closed or ambiguous */
      }
    assert(root.startsWith(join(tmpdir(), "executor-preparation-")));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    ...data,
    root,
    context,
    registry,
    journal,
    open,
    authority,
    boundary,
    preflight,
    input,
    createAdapter,
    seedConfirmed,
    observation,
    linkInput,
    linkAdapter,
  };
}
