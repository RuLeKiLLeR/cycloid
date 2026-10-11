import { z } from "zod";

import {
  PR_REVIEW_MAX_CITATION_CHARS,
  PR_REVIEW_MAX_CITATIONS,
  PR_REVIEW_MAX_FINDING_BODY_CHARS,
  PR_REVIEW_MAX_FINDINGS,
  PR_REVIEW_MAX_MARKDOWN_CHARS,
  PR_REVIEW_MAX_SUGGESTION_CHARS,
} from "../constants/pr-review-trigger";

const safeCitation = z
  .string()
  .min(1)
  .max(PR_REVIEW_MAX_CITATION_CHARS)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "Citation must be repo-relative.");

export const PrReviewPublishBodySchema = z
  .object({
    summaryMarkdown: z.string().min(1).max(PR_REVIEW_MAX_MARKDOWN_CHARS).optional(),
    verdict: z.enum(["clear", "issues_found", "inconclusive"]).default("inconclusive"),
    checks: z
      .array(
        z
          .object({
            command: z.string().max(1_000),
            reason: z.string().min(1).max(500),
            status: z.enum(["passed", "failed", "skipped"]),
            exitCode: z.number().int().nullable(),
            detail: z.string().min(1).max(500),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    scopeNotVerified: z.array(z.string().min(1).max(1_000)).max(20).default([]),
    confidenceScore: z.number().int().min(1).max(5),
    importantFiles: z
      .array(z.object({ path: z.string().min(1).max(1_000), reason: z.string().min(1).max(2_000) }).strict())
      .max(100),
    findings: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1_000),
            line: z.number().int().positive(),
            side: z.literal("RIGHT"),
            severity: z.enum(["P1", "P2"]),
            title: z.string().min(1).max(500),
            confidence: z.number().int().min(1).max(5).optional(),
            bodyMarkdown: z.string().min(1).max(PR_REVIEW_MAX_FINDING_BODY_CHARS),
            security: z.boolean().optional(),
            suggestion: z
              .string()
              .min(1)
              .max(PR_REVIEW_MAX_SUGGESTION_CHARS)
              .regex(/^[^`\r\n]+$/, "Suggestion must be a single replacement line.")
              .optional(),
            citations: z.array(safeCitation).max(PR_REVIEW_MAX_CITATIONS).optional(),
          })
          .strict(),
      )
      .max(PR_REVIEW_MAX_FINDINGS),
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .strict();
