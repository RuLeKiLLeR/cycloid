# Public status page custom domain.
#
# Points status.trycycloid.com at the standalone `cycloid-status` Worker
# (apps/status-worker). The Worker is deployed via wrangler in its own GitHub
# Actions workflow, not Terraform; this resource only attaches the hostname.

locals {
  status_page_hostname = "status.trycycloid.com"
  status_worker_script = "cycloid-status"
}

resource "cloudflare_workers_custom_domain" "status_page" {
  account_id = var.cloudflare_account_id
  hostname   = local.status_page_hostname
  service    = local.status_worker_script
  zone_id    = cloudflare_zone.main.id
}
