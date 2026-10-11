import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("desktop observability Terraform", () => {
  const terraform = readFileSync("infra/datadog-desktop.tf", "utf8");
  const soakDoc = readFileSync("docs/desktop-vnc-soak-criteria.md", "utf8");

  it("covers every desktop soak metric family with dashboard-only telemetry", () => {
    expect(terraform).toContain('resource "datadog_dashboard" "desktop_vnc_cua_soak"');
    for (const metric of [
      "arcanist.desktop.start_events",
      "arcanist.desktop.health_events",
      "arcanist.desktop.restart_events",
      "arcanist.desktop.tool_action_events",
      "arcanist.desktop.model_image_feedback_events",
      "arcanist.desktop.model_image_feedback_unsupported",
      "arcanist.desktop.model_image_feedback_fixture",
      "arcanist.desktop.screenshot_events",
      "arcanist.desktop.action_path_persist_events",
      "arcanist.desktop.recording_events",
      "arcanist.desktop.proxy_events",
      "arcanist.desktop.rate_limited_events",
      "arcanist.desktop.artifact_selected_events",
      "arcanist.desktop.artifact_publish_events",
    ]) {
      expect(terraform).toContain(metric);
    }
  });

  it("includes desktop proxy failure boundaries and diagnostic dimensions", () => {
    for (const event of [
      "desktop.proxy_upstream_resolve",
      "desktop.proxy_ws_handshake",
      "desktop.proxy_ticket_operation_failed",
    ]) {
      expect(terraform).toContain(event);
    }
    for (const tag of ["event_source", "phase", "failed_component", "operation", "close_source"]) {
      expect(terraform).toContain(`tag_name = "${tag}"`);
    }
  });

  it("documents that monitors wait for internal baseline volume", () => {
    expect(terraform).not.toContain('resource "datadog_monitor"');
    expect(terraform).toContain("Do not add alert monitors until internal baseline volume");
    expect(soakDoc).toContain("PR 18 intentionally adds no Datadog monitors");
    expect(soakDoc).toContain("Add monitors only after baseline volume establishes actionable thresholds");
  });
});
