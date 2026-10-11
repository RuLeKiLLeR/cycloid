output "app_url" {
  description = "Application URL"
  value       = "https://${var.domain_name}"
}

output "cloudflare_nameservers" {
  description = "Cloudflare nameservers — update domain registrar with these to activate the zone"
  value       = cloudflare_zone.main.name_servers
}
