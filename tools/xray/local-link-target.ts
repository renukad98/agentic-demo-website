export const localLinkTargets = {
  "KAN-26": {
    story: "KAN-25",
    storyIssueId: "10065",
    issueId: "10066",
    identity:
      "agentic-demo-website:playwright:task-create-inflight-single-submit-v1",
    type: "Generic",
  },
  "KAN-28": {
    story: "KAN-25",
    storyIssueId: "10065",
    stepCount: 9,
    issueId: "10068",
    identity: "agentic-demo-website:manual:KAN-25:TM-TC-22",
    type: "Manual",
  },
  "KAN-30": {
    story: "KAN-29",
    storyIssueId: "10069",
    issueId: "10070",
    stepCount: 2,
    identity: "agentic-demo-website:manual:KAN-29:KAN-29-TC-001",
    type: "Manual",
  },
} as const;

export type LocalLinkTarget = keyof typeof localLinkTargets;

export function localLinkTarget(value = "KAN-26"): LocalLinkTarget {
  if (value !== "KAN-26" && value !== "KAN-28" && value !== "KAN-30")
    throw new Error("UNSUPPORTED_LOCAL_LINK_TARGET");
  return value;
}
