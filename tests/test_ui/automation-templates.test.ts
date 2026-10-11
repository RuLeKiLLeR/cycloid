import { describe, expect, it } from "vitest";

import { humanizeCron } from "../../apps/ui/src/components/automations/format";
import {
  AUTOMATION_TEMPLATE_CATEGORIES,
  AUTOMATION_TEMPLATE_CONNECTORS,
  AUTOMATION_TEMPLATES,
  SCHEDULED_AUTOMATION_TEMPLATES,
} from "../../apps/ui/src/constants/automationTemplates";
import { buildCronFromPreset, HOUR_OPTIONS } from "../../apps/ui/src/constants/scheduleCron";

// Mirrors AUTOMATION_RULE_NAME_MAX_LENGTH / AUTOMATION_RULE_PROMPT_MAX_LENGTH in
// apps/control-plane-worker/src/constants/automation.ts (server source of
// truth, not importable across apps). If those change, update these too.
const NAME_MAX_LENGTH = 80;
const PROMPT_MAX_LENGTH = 8000;

describe("AUTOMATION_TEMPLATES", () => {
  it("ships only the 12 available scheduled templates with unique ids", () => {
    expect(SCHEDULED_AUTOMATION_TEMPLATES).toHaveLength(12);
    expect(AUTOMATION_TEMPLATES).toHaveLength(12);
    const ids = AUTOMATION_TEMPLATES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(AUTOMATION_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s has a valid category and known connectors",
    (_id, template) => {
      expect(AUTOMATION_TEMPLATE_CATEGORIES).toContain(template.category);
      expect(template.connectors.length).toBeGreaterThan(0);
      for (const connector of template.connectors) {
        expect(AUTOMATION_TEMPLATE_CONNECTORS).toContain(connector);
      }
    },
  );
});

describe("SCHEDULED_AUTOMATION_TEMPLATES", () => {
  it.each(SCHEDULED_AUTOMATION_TEMPLATES.map((t) => [t.id, t] as const))(
    "%s has valid, prefillable form data",
    (_id, template) => {
      expect(template.trigger).toEqual({ kind: "schedule" });

      // Length limits the server enforces.
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.name.length).toBeLessThanOrEqual(NAME_MAX_LENGTH);
      // Outcome line: what the run produces, always naming the no-op case so
      // the card never promises a PR the run may honestly not open.
      expect(template.outcome.length).toBeGreaterThan(0);
      expect(template.outcome).toMatch(/no PR/);
      expect(template.prompt.length).toBeGreaterThan(0);
      expect(template.prompt.length).toBeLessThanOrEqual(PROMPT_MAX_LENGTH);
      // The prompt must spell out the explicit no-op arm, not just imply it.
      expect(template.prompt).toMatch(/do not open a PR/);

      // hour must match an <option> in the form's hour select, else the
      // prefilled <select> renders blank. (minute is type-guaranteed by its
      // literal union; preset is type-guaranteed to be weekly-* or daily.)
      expect(HOUR_OPTIONS).toContain(template.hour);

      // The preset must produce a valid 5-field cron once hour/minute are applied.
      const cron = buildCronFromPreset(template.preset, template.hour, template.minute);
      const fields = cron.trim().split(/\s+/);
      expect(fields).toHaveLength(5);
      // minute hour * * <day> (weekly) or minute hour * * * (daily).
      expect(fields[0]).toBe(String(template.minute));
      expect(fields[1]).toBe(String(template.hour));
      if (template.preset === "daily") {
        expect(fields[4]).toBe("*");
      } else {
        expect(fields[4]).toBe(template.preset.slice(-1));
      }

      // The gallery's "when" label is humanizeCron(buildCronFromPreset(...)).
      // humanizeCron falls back to the raw expression when it does not
      // recognize a cron, so a recognized (non-raw) label proves the card
      // advertises exactly the schedule the builder prefills.
      expect(humanizeCron(cron)).not.toBe(cron);
    },
  );
});
