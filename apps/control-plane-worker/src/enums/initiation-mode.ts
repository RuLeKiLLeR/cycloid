/**
 * How a session was initiated. Drives provenance rendering (PR-body footer,
 * `cycloid:scheduled` label, UI badge) and observability filtering. Auth and
 * sandbox identity are not branched on this value: scheduled sessions still
 * run under the configuring user's credentials.
 */
export const InitiationMode = {
  USER: "user",
  CHILD: "child",
  AUTOMATION: "automation",
} as const;

export type InitiationMode = (typeof InitiationMode)[keyof typeof InitiationMode];

export function isInitiationMode(value: unknown): value is InitiationMode {
  return value === InitiationMode.USER || value === InitiationMode.CHILD || value === InitiationMode.AUTOMATION;
}

export function parseInitiationMode(value: unknown): InitiationMode {
  return isInitiationMode(value) ? value : InitiationMode.USER;
}
