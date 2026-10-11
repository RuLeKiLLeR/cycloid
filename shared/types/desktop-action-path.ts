export const DESKTOP_ACTION_PATH_PHASES = ["agent", "verification_operator"] as const;
export type DesktopActionPathPhase = (typeof DESKTOP_ACTION_PATH_PHASES)[number];

export const DESKTOP_ACTION_PATH_ACTIONS = [
  "observe",
  "screenshot",
  "click",
  "type",
  "hotkey",
  "scroll",
  "drag",
  "open_app",
  "focus_window",
] as const;
export type DesktopActionPathAction = (typeof DESKTOP_ACTION_PATH_ACTIONS)[number];

export const DESKTOP_ACTION_PATH_STATUSES = [
  "completed",
  "action_failed",
  "desktop_unavailable",
  "screenshot_failed",
  "quota_exceeded",
  "pruned",
] as const;
export type DesktopActionPathStatus = (typeof DESKTOP_ACTION_PATH_STATUSES)[number];

export const DESKTOP_ACTION_SCREENSHOT_STATUSES = ["available", "failed", "quota_exceeded", "pruned"] as const;
export type DesktopActionScreenshotStatus = (typeof DESKTOP_ACTION_SCREENSHOT_STATUSES)[number];

export type DesktopActionScreenshotRef = {
  actionId: string;
  artifactId: string;
  kind: "desktop_action_screenshot";
  artifactAccessVisibility: "private";
  label: string;
  viewUrl: string;
  width: number;
  height: number;
  bytes: number;
  captureMode: "full_display" | null;
  displayName: string | null;
  capturedAtMs: number;
  status: DesktopActionScreenshotStatus;
};

export type DesktopActionPathRow = {
  actionId: string;
  desktopActionSeq: number;
  sessionId: string;
  promptId: string | null;
  phase: DesktopActionPathPhase;
  action: DesktopActionPathAction;
  label: string;
  status: DesktopActionPathStatus;
  activeWindowTitle: string | null;
  warningCode: string | null;
  errorCode: string | null;
  screenshot: DesktopActionScreenshotRef | null;
  createdAtMs: number;
  updatedAtMs: number;
};

export type RegisterDesktopActionPathRowRequest = Omit<DesktopActionPathRow, "desktopActionSeq" | "sessionId">;

export type RegisterDesktopActionPathRowResponse = {
  ok: true;
  row: DesktopActionPathRow;
  idempotent: boolean;
  updated: boolean;
};

export type DesktopActionPathSnapshotResponse = {
  ok: true;
  rows: DesktopActionPathRow[];
  maxDesktopActionSeq: number;
};
