interface SecretRule {
  name: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { name: "aws_access_key", pattern: /AKIA[0-9A-Z]{16}/ },
  { name: "cycloid_cli_token", pattern: /arc_[a-f0-9]{64}/ },
  { name: "e2b_api_key", pattern: /e2b_[A-Za-z0-9]{16,}/ },
  { name: "github_pat", pattern: /gh[opusr]_[A-Za-z0-9]{36}/ },
  { name: "github_pat_fine_grained", pattern: /github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/ },
  { name: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: "stripe_live", pattern: /sk_live_[A-Za-z0-9]{24,}/ },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{32,}/ },
  { name: "openai_key", pattern: /sk-(?:(?:proj-|svcacct-|ant-)[A-Za-z0-9_-]{32,}|[A-Za-z0-9]{32,})/ },
  // No Baseten rule: real Baseten keys are `<segment>.<segment>` with no
  // distinctive prefix, so any value-regex broad enough to match them also
  // matches ordinary dotted text (domains, versions). The Baseten key is
  // protected by name-based env handling instead (see durable-object spawn
  // guards), matching how #5841 treats ARCANIST_BASETEN_API_KEY.
  { name: "private_key_pem", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "jwt_like", pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
];

export function scanForSecrets(text: string): { quarantined: boolean; reason?: string } {
  for (const rule of SECRET_RULES) {
    if (rule.pattern.test(text)) return { quarantined: true, reason: rule.name };
  }
  return { quarantined: false };
}
