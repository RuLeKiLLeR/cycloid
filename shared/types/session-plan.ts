export type SessionPlanStatus = "none" | "pending" | "approved" | "superseded";

export type PlanApprovalMetadata = {
  planApprovalPending: boolean;
  planRevision: number;
  planStatus: SessionPlanStatus;
};
