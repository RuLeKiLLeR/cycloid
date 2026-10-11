import { isRecord } from "../../../../shared/utils/type-guards.js";
import { createLogger } from "../logger";
import { tracedFetch } from "../observability/wrappers";
import { asNonEmptyString } from "../utils.js";
import type { LinearIssuePromptComment } from "./prompts";

const log = createLogger({ bindings: { component: "webhook" } });

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
const LINEAR_COMMENTS_TIMEOUT_MS = 5_000;
const LINEAR_COMMENTS_QUERY = `
  query LinearIssueRecentComments($linearIssueId: String!) {
    issue(id: $linearIssueId) {
      comments(last: 5) {
        nodes {
          body
          user {
            name
          }
        }
      }
    }
  }
`;

function parseLinearIssueComments(body: unknown): LinearIssuePromptComment[] | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.errors) && body.errors.length > 0) return null;

  const data = body.data;
  if (!isRecord(data)) return null;
  const issue = data.issue;
  if (!isRecord(issue)) return null;
  const comments = issue.comments;
  if (!isRecord(comments)) return null;
  const nodes = comments.nodes;
  if (!Array.isArray(nodes)) return null;

  return nodes.flatMap((node) => {
    if (!isRecord(node) || typeof node.body !== "string") return [];
    const user = isRecord(node.user) ? node.user : null;
    const authorName = asNonEmptyString(user?.name) ?? "linear_user";
    return [{ body: node.body, authorName }];
  });
}

export async function fetchLinearIssueRecentComments(
  linearToken: string,
  linearIssueId: string,
): Promise<LinearIssuePromptComment[]> {
  try {
    const res = await tracedFetch(
      LINEAR_GRAPHQL_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${linearToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: LINEAR_COMMENTS_QUERY,
          variables: { linearIssueId },
        }),
        signal: AbortSignal.timeout(LINEAR_COMMENTS_TIMEOUT_MS),
      },
      "linear.issue.comments",
    );

    if (!res.ok) {
      log.warn({ linearIssueId, status: res.status }, "Linear comments fetch failed");
      return [];
    }

    let responseBody: unknown;
    try {
      responseBody = await res.json();
    } catch (err) {
      log.warn({ linearIssueId, error: String(err) }, "Linear comments fetch returned malformed JSON");
      return [];
    }

    const comments = parseLinearIssueComments(responseBody);
    if (!comments) {
      log.warn({ linearIssueId }, "Linear comments fetch returned unexpected response shape");
      return [];
    }
    return comments;
  } catch (err) {
    log.warn({ linearIssueId, error: String(err) }, "Linear comments fetch failed");
    return [];
  }
}
