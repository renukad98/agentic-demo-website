export interface ManualTestPublicationInput {
  readonly approvalId: string;
  readonly projectKey: string;
  readonly summary: string;
  readonly description?: string;
  readonly steps: readonly { readonly action: string; readonly data: string; readonly result: string }[];
  readonly jiraFields: Readonly<Record<string, unknown>>;
  readonly testCaseId: string;
  readonly workflowId: string;
  readonly workflowCorrelationId: string;
}

