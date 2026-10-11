import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PromptHistoryFetchResult } from "../../apps/ui/src/api/sessions";
import { useSessionState } from "../../apps/ui/src/hooks/useSessionState";
import type { PromptRow, SessionDetail } from "../../apps/ui/src/types";

let happyWindow: Window;
let root: Root;
let container: HTMLElement;

function installDomGlobals(windowInstance: Window) {
  const globals = {
    window: windowInstance,
    document: windowInstance.document,
    navigator: windowInstance.navigator,
    localStorage: windowInstance.localStorage,
    HTMLElement: windowInstance.HTMLElement,
    SVGElement: windowInstance.SVGElement,
    Node: windowInstance.Node,
    Event: windowInstance.Event,
  };

  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }

  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    writable: true,
    value: true,
  });
}

function makeSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    sessionId: "s-1",
    status: "idle",
    title: "Session",
    repoUrl: "https://github.com/test-owner/test-repo",
    prUrl: null,
    createdAt: 0,
    model: null,
    queueLength: 0,
    prCreating: false,
    lastBranch: null,
    baseBranch: "main",
    ...overrides,
  };
}

function makePrompt(promptId: string, options?: Partial<PromptRow>): PromptRow {
  return {
    promptId,
    session_id: "s-1",
    prompt: "Do the thing",
    result: null,
    status: "processing",
    ...options,
  };
}

function okPromptHistory(
  events: Array<{ type: string; id: string; text: string }>,
  maxSequence: number,
  promptId = "p-1",
): PromptHistoryFetchResult {
  return {
    ok: true,
    result: {
      events,
      maxSequence,
    },
    rawEvents: events.map((event, index) => ({
      sequence: maxSequence - events.length + index + 1,
      type: event.type,
      data: { promptId, id: event.id, text: event.text },
    })),
  };
}

type HarnessApi = ReturnType<typeof useSessionState>;
let harnessApi: HarnessApi;

function Harness() {
  harnessApi = useSessionState({ sessionId: "s-1", initialSession: makeSession() });
  return null;
}

describe("useSessionState prompt history authority", () => {
  beforeEach(() => {
    happyWindow = new Window({ url: "https://app.trycycloid.com/sessions/s-1" });
    installDomGlobals(happyWindow);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(createElement(Harness));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    happyWindow.close();
  });

  it("merges completed prompt history into replay-populated transcripts", () => {
    const prompt = makePrompt("p-1", { result: "done", status: "completed" });

    act(() => {
      harnessApi.initializeSessionData(makeSession(), [prompt]);
      harnessApi.ingestReplayPage([
        { sequence: 1, type: "text", data: { promptId: "p-1", id: "t-1", text: "partial" } },
      ]);
    });

    expect(harnessApi.state.transcripts.get("p-1")).toEqual([
      { type: "text", id: "t-1", promptId: "p-1", text: "partial" },
    ]);

    act(() => {
      harnessApi.applyPromptHistoryFetchResult(
        "p-1",
        okPromptHistory([{ type: "text", id: "t-2", text: "full transcript" }], 10),
      );
    });

    expect(harnessApi.state.transcripts.get("p-1")).toEqual([
      { type: "text", id: "t-1", promptId: "p-1", text: "partial" },
      { type: "text", id: "t-2", promptId: "p-1", text: "full transcript" },
    ]);
  });

  it("merges behind-live prompt history for an active prompt when live durable events are newer", () => {
    const prompt = makePrompt("p-1");

    act(() => {
      harnessApi.initializeSessionData(makeSession({ status: "running" }), [prompt]);
      harnessApi.ingestReplayPage([
        { sequence: 5, type: "text", data: { promptId: "p-1", id: "t-5", text: "newer live event" } },
      ]);
    });

    let outcome!: ReturnType<HarnessApi["applyPromptHistoryFetchResult"]>;
    act(() => {
      outcome = harnessApi.applyPromptHistoryFetchResult(
        "p-1",
        okPromptHistory([{ type: "text", id: "t-4", text: "older history" }], 4),
      );
    });

    expect(outcome.staleDiscarded).toBe(true);
    expect(harnessApi.state.transcripts.get("p-1")).toEqual([
      { type: "text", id: "t-4", promptId: "p-1", text: "older history" },
      { type: "text", id: "t-5", promptId: "p-1", text: "newer live event" },
    ]);
  });

  it("keeps authoritative prompt history across refreshes", () => {
    const prompt = makePrompt("p-1", { result: "done", status: "completed" });

    act(() => {
      harnessApi.initializeSessionData(makeSession(), [prompt]);
      harnessApi.applyPromptHistoryFetchResult(
        "p-1",
        okPromptHistory([{ type: "text", id: "t-9", text: "authoritative transcript" }], 9),
      );
      harnessApi.mergeSessionMetadata(makeSession(), [prompt]);
    });

    expect(harnessApi.state.transcripts.get("p-1")).toEqual([
      { type: "text", id: "t-9", promptId: "p-1", text: "authoritative transcript" },
    ]);
  });

  it("does not promote stale active-phase history when a prompt later completes", () => {
    const runningPrompt = makePrompt("p-1");
    const completedPrompt = makePrompt("p-1", { result: "done", status: "completed" });

    act(() => {
      harnessApi.initializeSessionData(makeSession({ status: "running" }), [runningPrompt]);
      harnessApi.ingestReplayPage([
        { sequence: 4, type: "text", data: { promptId: "p-1", id: "t-4", text: "history snapshot" } },
      ]);
      harnessApi.applyPromptHistoryFetchResult(
        "p-1",
        okPromptHistory([{ type: "text", id: "t-4", text: "history snapshot" }], 4),
      );
      harnessApi.ingestLiveEvent({
        sequence: 5,
        type: "text",
        data: { promptId: "p-1", id: "t-5", text: "newer live event" },
      });
      harnessApi.mergeSessionMetadata(makeSession(), [completedPrompt]);
    });

    expect(harnessApi.state.transcripts.get("p-1")).toEqual([
      { type: "text", id: "t-4", promptId: "p-1", text: "history snapshot" },
      { type: "text", id: "t-5", promptId: "p-1", text: "newer live event" },
    ]);
  });

  it("keeps exported state actions stable across rerenders", () => {
    const refsBefore = {
      initializeSessionData: harnessApi.initializeSessionData,
      mergeSessionMetadata: harnessApi.mergeSessionMetadata,
      ingestReplayPage: harnessApi.ingestReplayPage,
      applyPromptHistoryFetchResult: harnessApi.applyPromptHistoryFetchResult,
    };

    act(() => {
      harnessApi.initializeSessionData(makeSession(), [makePrompt("p-1")]);
    });

    expect(harnessApi.initializeSessionData).toBe(refsBefore.initializeSessionData);
    expect(harnessApi.mergeSessionMetadata).toBe(refsBefore.mergeSessionMetadata);
    expect(harnessApi.ingestReplayPage).toBe(refsBefore.ingestReplayPage);
    expect(harnessApi.applyPromptHistoryFetchResult).toBe(refsBefore.applyPromptHistoryFetchResult);
  });
});
