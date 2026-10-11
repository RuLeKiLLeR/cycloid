# --- Cloudflare Zone ---

locals {
  production_control_plane_worker_hostname    = "api.trycycloid.com"
  production_control_plane_worker_script_name = "cycloid-control-plane-production"
}

resource "cloudflare_zone" "main" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "trycycloid.com"
}

# --- R2 Bucket for Persistent UI Assets ---

resource "cloudflare_r2_bucket" "ui_assets" {
  account_id = var.cloudflare_account_id
  name       = "cycloid-ui-assets"
}

# --- Cloudflare Pages Project ---

resource "cloudflare_pages_project" "ui" {
  account_id        = var.cloudflare_account_id
  name              = "cycloid-ui"
  production_branch = "main"

  deployment_configs = {
    production = {
      fail_open = true
      env_vars = {
        WORKER_HOST = {
          type  = "plain_text"
          value = local.production_control_plane_worker_hostname
        }
      }
      r2_buckets = {
        UI_ASSETS_BUCKET = {
          name = cloudflare_r2_bucket.ui_assets.name
        }
      }
    }
    preview = {
      fail_open = true
    }
  }
}

# --- Control Plane Worker Custom Domain ---

resource "cloudflare_workers_custom_domain" "production_control_plane" {
  account_id = var.cloudflare_account_id
  hostname   = local.production_control_plane_worker_hostname
  service    = local.production_control_plane_worker_script_name
  zone_id    = cloudflare_zone.main.id
}

# --- Custom Domain for Pages ---

resource "cloudflare_pages_domain" "app" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.ui.name
  name         = var.domain_name
}

resource "cloudflare_dns_record" "app" {
  zone_id = cloudflare_zone.main.id
  name    = "app"
  type    = "CNAME"
  content = "${cloudflare_pages_project.ui.name}.pages.dev"
  proxied = true
  ttl     = 1
}

# --- Internal Dogfood Frontend (Cloudflare Pages) ---
# Second UI deployment for internally dogfooding the UX redesign against the
# SAME prod control plane. Mirrors the prod Pages project above (WORKER_HOST =
# api.trycycloid.com, shared UI_ASSETS_BUCKET R2 fallback) but serves the
# feature branch at internal.app.trycycloid.com. The R2 fallback holds
# content-addressed, hashed chunks, so sharing the bucket across the prod and
# internal deploys is safe (a hashed key resolves to the same immutable asset).
# GitHub sign-in works at this host because the control plane allowlists
# INTERNAL_FRONTEND_URL and picks the redirect host from X-Forwarded-Host.
resource "cloudflare_pages_project" "ui_internal" {
  account_id = var.cloudflare_account_id
  name       = "cycloid-ui-internal"
  # Deliberately a feature branch: this project is a temporary dogfood window
  # for the UI redesign. Cloudflare Pages silently stops deploying if this
  # branch is deleted or force-moved, so when the redesign merges to main,
  # either flip this to "main" (keeping an internal mirror of prod) or remove
  # this project + domain + DNS record entirely.
  production_branch = "ux-overhaul-control-room"

  deployment_configs = {
    production = {
      fail_open = true
      env_vars = {
        WORKER_HOST = {
          type  = "plain_text"
          value = local.production_control_plane_worker_hostname
        }
      }
      r2_buckets = {
        UI_ASSETS_BUCKET = {
          name = cloudflare_r2_bucket.ui_assets.name
        }
      }
    }
    preview = {
      fail_open = true
    }
  }
}

resource "cloudflare_pages_domain" "app_internal" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.ui_internal.name
  name         = "internal.app.trycycloid.com"
}

resource "cloudflare_dns_record" "app_internal" {
  zone_id = cloudflare_zone.main.id
  name    = "internal.app"
  type    = "CNAME"
  content = "${cloudflare_pages_project.ui_internal.name}.pages.dev"
  proxied = true
  ttl     = 1
}

# --- Docs Site (static Cloudflare Pages project) ---

resource "cloudflare_pages_project" "docs" {
  account_id        = var.cloudflare_account_id
  name              = "cycloid-docs"
  production_branch = "main"

  deployment_configs = {
    production = {
      fail_open = true
    }
    preview = {
      fail_open = true
    }
  }
}

resource "cloudflare_pages_domain" "docs" {
  account_id   = var.cloudflare_account_id
  project_name = cloudflare_pages_project.docs.name
  name         = "docs.trycycloid.com"
}

resource "cloudflare_dns_record" "docs" {
  zone_id = cloudflare_zone.main.id
  name    = "docs"
  type    = "CNAME"
  content = "${cloudflare_pages_project.docs.name}.pages.dev"
  proxied = true
  ttl     = 1
}

# --- Email (Google Workspace) ---

resource "cloudflare_dns_record" "mx" {
  zone_id  = cloudflare_zone.main.id
  name     = "@"
  type     = "MX"
  content  = "smtp.google.com"
  priority = 1
  ttl      = 3600
}

resource "cloudflare_dns_record" "spf" {
  zone_id = cloudflare_zone.main.id
  name    = "@"
  type    = "TXT"
  content = "v=spf1 include:_spf.google.com ~all"
  ttl     = 3600
}

resource "cloudflare_dns_record" "dkim" {
  zone_id = cloudflare_zone.main.id
  name    = "google._domainkey"
  type    = "TXT"
  content = "v=DKIM1;k=rsa;p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtPqda4JkNuZdXV1V/kfpM7zoIo3+hpEK8FiXsRSPivKiSjnGNq5cl7W5HDkiXZb+v/HceOdQZXXL7ij3vyu153pBuRwxGTZKDhj5R1vbs+RIyRqlRhj2sYOrf8SOZrSXYiVXFQGh0DnDS2BQVHLBADpzwMxCvG4pGzV2YXA5Xz9rLEUV7Bh+tp8U8WrLuBHsyj6UubzIrj5iGl0/vV+IDDm1Z8/fFO3jzWj/CKZgJKdzMsJRn2XTq3cbnmz42G3EqPpNeYipa+mun++uTbsIySTD2G7XQXDe3foaSjeu5gxWGr67AbMP/vPcLCZlloUEgEMo5R/BipzyTTwcD2wSiwIDAQAB"
  ttl     = 3600
}

resource "cloudflare_dns_record" "google_site_verification" {
  zone_id = cloudflare_zone.main.id
  name    = "@"
  type    = "TXT"
  content = "google-site-verification=IkTdgtGd43Grt0opapC_-9qjKi6QpXes4f3Tv9r5CoM"
  ttl     = 3600
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = cloudflare_zone.main.id
  name    = "_dmarc"
  type    = "TXT"
  content = "v=DMARC1; p=none; rua=mailto:shivam@trycycloid.com"
  ttl     = 3600
}
