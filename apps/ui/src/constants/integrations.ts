// Slack workspace install entrypoint. Owned here (not inside a settings
// component) so GetStartedSettings and IntegrationsSettings share one URL
// without a component-to-component import (docs/conventions.md: constants
// belong in app-local `constants/`).
export const SLACK_WORKSPACE_INSTALL_URL = "/auth/slack/install?returnTo=%2Fsettings%2Fintegrations";
