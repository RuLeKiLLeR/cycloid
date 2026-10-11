locals {
  cloudflare_deny_ip_expression = "ip.src in {${join(" ", var.cloudflare_deny_ips)}}"
}

# Bot Fight Mode disabled, not deleted. It 403s legitimate datacenter
# traffic (including our own CI schema-verify gate) and is not the right
# fit on the current plan. The cloudflare_bot_management resource has an
# empty Delete in provider v5: removing the block leaves fight_mode=true
# live in the API and unmanaged, so we keep the resource and turn it off
# via an update instead. Restoration tracked with the WAF re-add in
# ARC-1299.
resource "cloudflare_bot_management" "main" {
  zone_id    = cloudflare_zone.main.id
  fight_mode = false
  enable_js  = false
}

resource "cloudflare_turnstile_widget" "github_auth" {
  account_id = var.cloudflare_account_id
  name       = "Cycloid GitHub auth"
  # Order matches the order the Cloudflare API returns (alphabetical). The
  # provider models `domains` as an order-sensitive list, so a different order
  # here produces a perpetual in-place update that cascades through the widget
  # secret into the dependent turnstile SSM params (ssm.tf, qa.tf).
  domains = [
    "app.trycycloid.com",
    "localhost",
    "qa.app.trycycloid.com",
  ]
  mode = "managed"
}

# Custom deny list. Only create the ruleset when there are IPs to block:
# an empty deny list renders the expression as the literal "false", which
# Cloudflare's filter parser rejects.
resource "cloudflare_ruleset" "zone_custom_firewall" {
  count = length(var.cloudflare_deny_ips) > 0 ? 1 : 0

  zone_id     = cloudflare_zone.main.id
  name        = "Custom firewall entry point"
  description = "Cycloid custom deny list."
  kind        = "zone"
  phase       = "http_request_firewall_custom"

  rules = [
    {
      ref         = "custom_deny_ip_list"
      description = "Block explicitly denied IPs and CIDR ranges"
      expression  = local.cloudflare_deny_ip_expression
      action      = "block"
    },
  ]
}

# Auth rate limiting removed: the rule relies on advanced rate-limiting
# features (managed_challenge action, custom counting characteristics) that
# are paid-plan entitlements not available on the current Cloudflare tier.
# Tracked for restoration with the WAF re-add in ARC-1299. Until then,
# /auth/* abuse is covered by Turnstile.
