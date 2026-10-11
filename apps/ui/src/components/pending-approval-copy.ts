export type PendingApprovalVariant = "pending" | "denied";

export const PENDING_APPROVAL_COPY: Record<PendingApprovalVariant, { title: string; body: string }> = {
  pending: {
    title: "Waiting for approval",
    body: "Your Cycloid account is pending review. Email shivam@trycycloid.com for early access.",
  },
  denied: {
    title: "Access unavailable",
    body: "This account does not have access to Cycloid. Contact your administrator if you believe this is a mistake.",
  },
};
