terraform {
  required_version = ">= 1.7"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.0"
    }
  }

  cloud {
    organization = "cycloid"
    workspaces {
      name = "cycloid-infra"
    }
  }
}

provider "cloudflare" {
  # CLOUDFLARE_API_TOKEN set as TFC environment variable
}

provider "datadog" {
  # DD_API_KEY, DD_APP_KEY, and DD_HOST set as TFC environment variables
  # DD_HOST must be https://api.us5.datadoghq.com (our org is on US5)
  # Terraform refreshes a large Datadog surface area here (especially
  # datadog_logs_metric resources), and transient Datadog 429s during state
  # reads should not fail an otherwise-valid run.
  http_client_retry_max_retries = 5
  http_client_retry_timeout     = 300
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = var.project_name
      ManagedBy = "terraform"
    }
  }
}
