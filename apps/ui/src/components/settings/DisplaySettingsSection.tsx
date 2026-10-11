import { useDiffViewPreference } from "../../hooks/useDiffViewPreference";
import { Badge, SegmentedControl } from "../ui";
import { SettingsRow, SettingsSection } from "./SettingsLayout";

/**
 * Per-browser display preferences. These persist in localStorage only — the
 * control plane never reads them — so the scope badge says "This browser"
 * rather than the account-scoped SettingsScopeBadge.
 */
export function DisplaySettingsSection() {
  const [diffView, setDiffView] = useDiffViewPreference();

  return (
    <SettingsSection
      title="Display"
      description="How this browser renders session content."
      meta={<Badge title="Stored in this browser only.">This browser</Badge>}
    >
      <SettingsRow
        title="Diff view"
        description="How file diffs render in session transcripts."
        control={
          <SegmentedControl
            ariaLabel="Diff view"
            value={diffView}
            onChange={setDiffView}
            options={[
              { value: "unified", label: "Unified" },
              { value: "split", label: "Split" },
            ]}
          />
        }
      />
    </SettingsSection>
  );
}
