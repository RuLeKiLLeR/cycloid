# Desktop VNC/CUA Soak Criteria

Dashboard: Terraform-managed `datadog_dashboard.desktop_vnc_cua_soak`.

PR 18 intentionally adds no Datadog monitors. The desktop metric families are new and do not yet have internal baseline volume, so alert thresholds would be guesses.

Before broad rollout, use internal Cycloid sessions to prove:

- startup reaches `desktop.health status:available` and restarts stay bounded by component;
- XFCE core starts with DBus, `xfwm4`, `xfdesktop`, and `xfce4-panel` healthy on a `1440x900x24` display;
- health failures include a safe phase (`dbus_start`, `window_manager`, `desktop_root`, `panel`, `screenshot_capture`, `screenshot_black_or_uniform`, `vnc_ready`, `websockify_ready`, or `provider_port_resolve`);
- health rejects black or uniform screenshots using the non-black-pixel ratio or entropy fields;
- mutating `desktop.*` actions succeed and return screenshot feedback;
- `desktop.open_app` proves the target window is focused, and Chromium opens URLs without first-run/default-browser/sign-in prompts;
- `desktop.observe` and action screenshots report `captureMode: "full_display"` and show the XFCE panel or desktop root in the fixture;
- model image feedback succeeds for enabled backends and unsupported backends stay registration-blocked;
- screenshot quota/pruning events are rare and attributable;
- recordings stop with publishable WebM/proof screenshots;
- live viewer proxy connects, closes, and blocks keyboard, pointer, drag, and clipboard attempts;
- live viewer failures persist a sanitized close reason plus phase detail such as `screenshot_black_or_uniform`, `provider_port_resolve`, or `proxy_handshake.fetch_exception_*`;
- route limits trip only during reconnect bursts;
- selected desktop evidence publishes without fallback upload failures.

Add monitors only after baseline volume establishes actionable thresholds for sustained desktop unavailability, model-image feedback failure spikes, recording publish failures, or proxy connect failure spikes.
