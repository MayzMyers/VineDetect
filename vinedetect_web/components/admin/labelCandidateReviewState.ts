export type LabelCandidateReviewOperation = {
  scope?: { type?: string; id?: string | null } | null;
  helper?: { id?: string } | null;
  status?: string;
  candidates?: Array<{ id?: string }>;
};

export function isPersistedLabelCandidateRunReviewed(input: {
  packageId: string | null;
  candidateIds: string[];
  transientExecutionId: string | null;
  operations: LabelCandidateReviewOperation[];
}) {
  // A source-analysis response carrying its stage execution is a fresh UI
  // observation. Candidate ids are local to a run (for example
  // `label-consensus-1`) and may legally repeat in older reviewed operations.
  if (input.transientExecutionId || !input.packageId || !input.candidateIds.length) return false;
  return input.operations.some((operation) => operation.scope?.type === "package"
    && operation.scope.id === input.packageId
    && operation.helper?.id === "label-roi-detection"
    && operation.status === "reviewed"
    && input.candidateIds.every((candidateId) => operation.candidates?.some((stored) => stored.id === candidateId)));
}
