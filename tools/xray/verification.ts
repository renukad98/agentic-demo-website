export function verifyCoverage(
  storyIssueId: string,
  pages: { total: number; start: number; results: { issueId: string }[] }[],
) {
  if (!pages.length) throw new Error("Missing coverage read-back");
  const total = pages[0]!.total;
  let count = 0;
  for (const page of pages) {
    if (
      page.total !== total ||
      page.start !== count ||
      (!page.results.length && count < total)
    )
      throw new Error("Incomplete or changing coverage pagination");
    count += page.results.length;
  }
  if (count !== total) throw new Error("Incomplete coverage read-back");
  if (
    !pages.some((page) =>
      page.results.some((issue) => issue.issueId === storyIssueId),
    )
  )
    throw new Error("Story missing from Xray coverage");
  return true;
}
export function verifyJiraLink(
  storyKey: string,
  testKey: string,
  links: { testKey: string; storyKey: string; typeId: string }[],
  typeId: string,
) {
  if (
    !links.some(
      (link) =>
        link.testKey === testKey &&
        link.storyKey === storyKey &&
        link.typeId === typeId,
    )
  )
    throw new Error("Jira Story-to-Test link missing");
  return true;
}
export function verifyResults(
  expected: { testIssueId: string; status: string }[],
  actual: { testIssueId: string; status: string; executionIssueId: string }[],
  executionIssueId: string,
  complete: boolean,
) {
  if (
    !complete ||
    actual.length !== expected.length ||
    new Set(actual.map((r) => r.testIssueId)).size !== actual.length
  )
    throw new Error("Incomplete/duplicate Test Run read-back");
  for (const result of expected)
    if (
      !actual.some(
        (r) =>
          r.testIssueId === result.testIssueId &&
          r.status === result.status &&
          r.executionIssueId === executionIssueId,
      )
    )
      throw new Error("Execution result mismatch");
  return true;
}
