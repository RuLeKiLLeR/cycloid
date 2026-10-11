import { describe, expect, it } from "vitest";

import {
  ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET,
  classifyPrReviewBotForTelemetry,
  CYCLOID_QA_BOT_KEY,
  knownReviewBotIdForActorLogin,
  matchReviewLoopBot,
  normalizeGitHubActorLogin,
  qaCommentVerdictActionable,
  resolveIngestBotKey,
} from "../../apps/control-plane-worker/src/github/pr-review-bots";
import { qaCommentMarker } from "../../apps/control-plane-worker/src/github/verification-comment-marker";
import type { PrReviewExpectedBot } from "../../shared/constants/pr-review-bots";

describe("ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET", () => {
  it("recognizes every Cycloid app env login (incl. QA) as owned", () => {
    // The QA app authors QTA comments as `cycloid-qa`; without it the marker-gated QTA-comment
    // admission drops every QA verification comment and the needs-work intake dispatches empty.
    for (const login of ["cycloid[bot]", "cycloid-dev[bot]", "cycloid-staging[bot]", "cycloid-qa", "cycloid-qa[bot]"]) {
      expect(ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(login))).toBe(true);
    }
  });

  it("does not treat third-party reviewers as Cycloid-owned", () => {
    for (const login of ["cursor[bot]", "greptile-apps", "chatgpt-codex-connector", "strix-security", "alice"]) {
      expect(ARCANIST_OWNED_GITHUB_ACTOR_LOGIN_SET.has(normalizeGitHubActorLogin(login))).toBe(false);
    }
  });
});

describe("matchReviewLoopBot", () => {
  const greptile: PrReviewExpectedBot = { type: "known", id: "greptile" };
  const coderabbit: PrReviewExpectedBot = { type: "known", id: "coderabbit" };
  const custom: PrReviewExpectedBot = { type: "custom", login: "acme-bot" };

  it("gates the KNOWN branch on authorType: a real bot matches, a User-type impostor is rejected", () => {
    // Core PR-6 fix: previously the known branch matched on login alias alone, so a User account
    // named like a known bot was folded into a worklist. Now authorType must be Bot/App.
    expect(
      matchReviewLoopBot({
        expectedBots: [greptile],
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toEqual({ key: "known:greptile", normalizedLogin: "greptile-apps" });
    expect(
      matchReviewLoopBot({
        expectedBots: [greptile],
        actorLogin: "greptile-apps",
        actorType: "User",
        signal: "activity",
      }),
    ).toBeNull();
  });

  it("narrows known bots by terminal-signal capability, but never for the worklist 'activity' signal", () => {
    // coderabbit's terminalSignals are review_submission + commit_status (NOT check_run).
    expect(
      matchReviewLoopBot({
        expectedBots: [coderabbit],
        actorLogin: "coderabbitai[bot]",
        actorType: "Bot",
        signal: "check_run",
      }),
    ).toBeNull();
    expect(
      matchReviewLoopBot({
        expectedBots: [coderabbit],
        actorLogin: "coderabbitai[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toEqual({ key: "known:coderabbit", normalizedLogin: "coderabbitai" });
  });

  it("matches custom bots only on review-ish signals and only when bot-typed", () => {
    expect(
      matchReviewLoopBot({ expectedBots: [custom], actorLogin: "acme-bot", actorType: "Bot", signal: "activity" }),
    ).toEqual({ key: "custom:acme-bot", normalizedLogin: "acme-bot" });
    for (const signal of ["issue_comment_final", "check_run", "commit_status"] as const) {
      expect(
        matchReviewLoopBot({ expectedBots: [custom], actorLogin: "acme-bot", actorType: "Bot", signal }),
      ).toBeNull();
    }
    // A User-type custom actor is rejected by the authorType gate.
    expect(
      matchReviewLoopBot({ expectedBots: [custom], actorLogin: "acme-bot", actorType: "User", signal: "activity" }),
    ).toBeNull();
  });

  it("rejects Cycloid-owned actors and empty logins", () => {
    expect(
      matchReviewLoopBot({
        expectedBots: [greptile],
        actorLogin: "cycloid[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
    expect(
      matchReviewLoopBot({ expectedBots: [greptile], actorLogin: "", actorType: "Bot", signal: "activity" }),
    ).toBeNull();
    expect(
      matchReviewLoopBot({ expectedBots: [greptile], actorLogin: null, actorType: "Bot", signal: "activity" }),
    ).toBeNull();
  });
});

describe("resolveIngestBotKey (allow-list ingest)", () => {
  const greptile: PrReviewExpectedBot = { type: "known", id: "greptile" };

  it("returns the configured allowlist key for a configured bot", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "greptile-apps[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toEqual({ key: "known:greptile", configured: true });
  });

  it("admits an UNCONFIGURED but KNOWN-registry reviewer respond-only (known:<id>, configured:false)", () => {
    // cursor-bugbot is a known review bot but NOT in this repo's expected list. It is still ingested so a
    // drive-by review is addressed — respond-only, and keyed known:<id> so the D4 noise gate can act on it.
    for (const signal of ["review_submission", "activity", "issue_comment_final"] as const) {
      expect(
        resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "cursor[bot]", actorType: "Bot", signal }),
      ).toEqual({ key: "known:cursor-bugbot", configured: false });
    }
  });

  it("DROPS an unlisted non-reviewer bot (allow-list restore of #6558)", () => {
    // linear[bot] linkbacks + CI/deploy/status bots are not reviewers → dropped (returns null → the caller
    // reports actor_not_configured_bot). This is the regression fix.
    for (const login of ["linear[bot]", "github-actions[bot]", "codecov[bot]", "vercel[bot]", "some-reviewer[bot]"]) {
      for (const signal of ["review_submission", "activity", "issue_comment_final"] as const) {
        expect(
          resolveIngestBotKey({ expectedBots: [greptile], actorLogin: login, actorType: "Bot", signal }),
        ).toBeNull();
      }
    }
  });

  it("does NOT fall back for terminal signals (check_run/commit_status stay allowlist-only)", () => {
    for (const signal of ["check_run", "commit_status"] as const) {
      expect(
        resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "cursor[bot]", actorType: "Bot", signal }),
      ).toBeNull();
    }
  });

  it("never ingests Cycloid-owned actors, non-bot authors, or empty logins", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
    // cycloid-qa is dropped UNLESS the comment carries the managed QA marker (see the carve-out block below).
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid-qa[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
    expect(
      resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "alice", actorType: "User", signal: "activity" }),
    ).toBeNull();
    expect(
      resolveIngestBotKey({ expectedBots: [greptile], actorLogin: "", actorType: "Bot", signal: "activity" }),
    ).toBeNull();
  });
});

describe("resolveIngestBotKey — QA managed-comment carve-out", () => {
  const greptile: PrReviewExpectedBot = { type: "known", id: "greptile" };
  const qaTarget = { owner: "acme", repo: "web", prNumber: 7 };
  const qaBody = `${qaCommentMarker("acme", "web", 7, "sha", "app_breaks")}\n## Cycloid QA`;

  it("admits a cycloid-qa comment carrying the marker, respond-only, keyed known:cycloid-qa", () => {
    for (const signal of ["review_submission", "activity", "issue_comment_final"] as const) {
      expect(
        resolveIngestBotKey({
          expectedBots: [greptile],
          actorLogin: "cycloid-qa[bot]",
          actorType: "Bot",
          signal,
          body: qaBody,
          qaMarkerTarget: qaTarget,
        }),
      ).toEqual({ key: CYCLOID_QA_BOT_KEY, configured: false });
    }
  });

  it("does NOT admit a cycloid-qa comment without the marker (loop must not feed on its own replies)", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid-qa[bot]",
        actorType: "Bot",
        signal: "activity",
        body: "plain cycloid-qa follow-up reply, no marker",
        qaMarkerTarget: qaTarget,
      }),
    ).toBeNull();
  });

  it("does NOT admit a non-QA cycloid actor even with a (spoofed) marker body", () => {
    for (const login of ["cycloid[bot]", "cycloid-dev[bot]", "cycloid-staging[bot]"]) {
      expect(
        resolveIngestBotKey({
          expectedBots: [greptile],
          actorLogin: login,
          actorType: "Bot",
          signal: "activity",
          body: qaBody,
          qaMarkerTarget: qaTarget,
        }),
      ).toBeNull();
    }
  });

  it("does NOT admit the QA comment on terminal check_run/commit_status signals", () => {
    for (const signal of ["check_run", "commit_status"] as const) {
      expect(
        resolveIngestBotKey({
          expectedBots: [greptile],
          actorLogin: "cycloid-qa[bot]",
          actorType: "Bot",
          signal,
          body: qaBody,
          qaMarkerTarget: qaTarget,
        }),
      ).toBeNull();
    }
  });

  it("still drops cycloid-qa when no marker target/body is supplied (back-compat with existing callers)", () => {
    expect(
      resolveIngestBotKey({
        expectedBots: [greptile],
        actorLogin: "cycloid-qa[bot]",
        actorType: "Bot",
        signal: "activity",
      }),
    ).toBeNull();
  });

  it("qaCommentVerdictActionable is true only for app_breaks", () => {
    expect(qaCommentVerdictActionable("app_breaks")).toBe(true);
    expect(qaCommentVerdictActionable("pass")).toBe(false);
    expect(qaCommentVerdictActionable("none")).toBe(false);
    expect(qaCommentVerdictActionable(null)).toBe(false);
  });
});

describe("knownReviewBotIdForActorLogin", () => {
  it("maps a known-registry alias login (with or without [bot]) to its id, else null", () => {
    expect(knownReviewBotIdForActorLogin("cursor[bot]")).toBe("cursor-bugbot");
    expect(knownReviewBotIdForActorLogin("greptile-apps")).toBe("greptile");
    expect(knownReviewBotIdForActorLogin("linear[bot]")).toBeNull();
    expect(knownReviewBotIdForActorLogin("")).toBeNull();
    expect(knownReviewBotIdForActorLogin(null)).toBeNull();
  });
});

describe("copilot registry seed", () => {
  it("recognizes GitHub Copilot review as a known reviewer, ingested respond-only when unconfigured", () => {
    expect(knownReviewBotIdForActorLogin("copilot-pull-request-reviewer[bot]")).toBe("copilot");
    expect(
      resolveIngestBotKey({
        expectedBots: [{ type: "known", id: "greptile" }],
        actorLogin: "copilot-pull-request-reviewer[bot]",
        actorType: "Bot",
        signal: "review_submission",
      }),
    ).toEqual({ key: "known:copilot", configured: false });
  });
});

describe("classifyPrReviewBotForTelemetry", () => {
  it("maps known registry aliases to their bounded known-bot id", () => {
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "cursor[bot]", actorType: "Bot" })).toBe("cursor-bugbot");
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "strix-security[bot]", actorType: "Bot" })).toBe("strix");
  });

  it("collapses unlisted bot actors to the generic custom bucket", () => {
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "some-reviewer[bot]", actorType: "Bot" })).toBe("custom");
  });

  it("treats Cycloid-owned, non-bot, and missing actors as unknown", () => {
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "cycloid[bot]", actorType: "Bot" })).toBe("unknown");
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "alice", actorType: "User" })).toBe("unknown");
    expect(classifyPrReviewBotForTelemetry({ actorLogin: "", actorType: "Bot" })).toBe("unknown");
  });
});
