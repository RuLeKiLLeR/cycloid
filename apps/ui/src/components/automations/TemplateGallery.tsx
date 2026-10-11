import { useState } from "react";

import {
  AUTOMATION_TEMPLATE_CATEGORIES,
  AUTOMATION_TEMPLATE_CONNECTORS,
  AUTOMATION_TEMPLATE_FILTER_ALL,
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
  type AutomationTemplateCategory,
  type ScheduledAutomationTemplate,
} from "../../constants/automationTemplates";
import { buildCronFromPreset } from "../../constants/scheduleCron";
import { ArtifactChip, Row, SegmentedControl, type SegmentedOption } from "../ui";
import { humanizeCron } from "./format";

type TemplateGalleryProps = {
  // Only scheduled templates are usable, enforced by the type: roadmap
  // templates carry no prompt/schedule fields, so the create flow cannot be
  // seeded from one.
  onUse: (template: ScheduledAutomationTemplate) => void;
};

type CategoryFilter = typeof AUTOMATION_TEMPLATE_FILTER_ALL | AutomationTemplateCategory;

const FILTER_OPTIONS: SegmentedOption<CategoryFilter>[] = [
  { value: AUTOMATION_TEMPLATE_FILTER_ALL, label: "All" },
  ...AUTOMATION_TEMPLATE_CATEGORIES.map((category) => ({ value: category, label: category })),
];

// The "when" label is derived from the template's real schedule fields (the
// same values the builder prefills), so the card can never advertise a trigger
// the created rule will not have.
function scheduleLabel(template: ScheduledAutomationTemplate): string {
  return humanizeCron(buildCronFromPreset(template.preset, template.hour, template.minute));
}

// Connector badges: grayscale mono chips, same family as the PR inbox's
// StatusChip/ArtifactChip. GitHub is currently the only connector value, so a
// chip repeating it on every row carries no information — chips return once a
// second connector exists in the union.
function connectorChips(template: AutomationTemplate) {
  if (AUTOMATION_TEMPLATE_CONNECTORS.length < 2) return undefined;
  if (template.connectors.length === 0) return undefined;
  return template.connectors.map((connector) => <ArtifactChip key={connector} kind="text" label={connector} />);
}

// Templates are a supporting gallery, not the page's main content, so they read
// as quiet labelled lists of rows grouped by category rather than a grid of
// equal-weight cards. Each row is trigger → outcome: the meta slot carries the
// trigger (derived schedule, or the event trigger name for roadmap cards), the
// subtitle carries what a run produces, and connector chips sit trailing.
// Clicking an enabled row seeds the builder; roadmap rows are not interactive.
export function TemplateGallery({ onUse }: TemplateGalleryProps) {
  const [filter, setFilter] = useState<CategoryFilter>(AUTOMATION_TEMPLATE_FILTER_ALL);

  const visibleCategories = AUTOMATION_TEMPLATE_CATEGORIES.filter(
    (category) => filter === AUTOMATION_TEMPLATE_FILTER_ALL || filter === category,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 px-1">
        <h2 className="text-sm font-medium text-text-secondary">Templates</h2>
        <p className="text-sm text-text-muted">
          Templates run on a schedule and end in a PR or a clean no-op. Pick one, then choose the repository.
        </p>
      </div>
      <SegmentedControl
        options={FILTER_OPTIONS}
        value={filter}
        onChange={setFilter}
        ariaLabel="Filter templates by category"
        className="self-start"
      />
      {visibleCategories.map((category) => {
        const templates = AUTOMATION_TEMPLATES.filter((template) => template.category === category);
        if (templates.length === 0) return null;
        return (
          <section key={category} className="flex flex-col gap-1.5">
            <h3 className="px-1 text-sm font-medium text-text-secondary">{category}</h3>
            <div className="flex flex-col overflow-hidden border border-border bg-surface-1 [&>*+*]:border-t [&>*+*]:border-border">
              {templates.map((template) => (
                <Row
                  key={template.id}
                  title={template.title}
                  subtitle={template.outcome}
                  meta={scheduleLabel(template)}
                  chips={connectorChips(template)}
                  trailing="Use →"
                  onClick={() => onUse(template)}
                  ariaLabel={`Use template: ${template.title}`}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
