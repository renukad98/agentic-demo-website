export const localLinkTargets = {
  "KAN-26": {
    issueId: "10066",
    identity:
      "agentic-demo-website:playwright:task-create-inflight-single-submit-v1",
    type: "Generic",
  },
  "KAN-28": {
    issueId: "10068",
    identity: "agentic-demo-website:manual:KAN-25:TM-TC-22",
    type: "Manual",
  },
} as const;

export type LocalLinkTarget = keyof typeof localLinkTargets;

export function localLinkTarget(value = "KAN-26"): LocalLinkTarget {
  if (value !== "KAN-26" && value !== "KAN-28")
    throw new Error("UNSUPPORTED_LOCAL_LINK_TARGET");
  return value;
}
