export const PUBLISH_STATUSES = ["not_started", "publishing", "published", "skipped", "superseded", "failed"] as const;

export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const PUBLISH_STAGES = ["verifying", "pushing", "creating_pr", "updating_pr", "done"] as const;

export type PublishStage = (typeof PUBLISH_STAGES)[number];
