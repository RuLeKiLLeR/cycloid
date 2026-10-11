import { listAutomationRunHistory } from "./run-history-db";

export async function getAutomationRunHistory(input: {
  db: D1Database;
  businessId: string;
  cursor: { createdAt: number; id: string; source: string } | null;
  limit: number;
}) {
  return listAutomationRunHistory(input.db, input);
}
