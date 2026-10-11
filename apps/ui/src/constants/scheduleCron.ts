// Cron primitives for the Scheduled runs form. Owned here (not inside the
// component) so both AutomationSchedulesSettings and the suggested-automation
// templates can share them without a re-export shim or a component-to-template
// circular import (docs/conventions.md: constants belong in app-local
// `constants/`; no mirrored exports).

export type SchedulePreset =
  | "hourly"
  | "daily"
  | "weekday"
  | "weekly-1"
  | "weekly-2"
  | "weekly-3"
  | "weekly-4"
  | "weekly-5"
  | "weekly-6"
  | "weekly-0"
  | "monthly"
  | "custom";

export const HOUR_OPTIONS = Array.from({ length: 24 }, (_, i) => i);
export const MINUTE_OPTIONS = [0, 15, 30, 45];

export function buildCronFromPreset(preset: SchedulePreset, hour: number, minute: number): string {
  switch (preset) {
    case "hourly":
      return "0 * * * *";
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekday":
      return `${minute} ${hour} * * 1-5`;
    case "weekly-0":
    case "weekly-1":
    case "weekly-2":
    case "weekly-3":
    case "weekly-4":
    case "weekly-5":
    case "weekly-6": {
      const day = preset.slice(-1);
      return `${minute} ${hour} * * ${day}`;
    }
    case "monthly":
      return `${minute} ${hour} 1 * *`;
    case "custom":
      return "";
  }
}
