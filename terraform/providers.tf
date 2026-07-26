terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }
}

# Primary region for S3 + EC2 (matches how we deployed manually).
provider "aws" {
  region = var.region
}

# CloudFront itself is global, but an ACM certificate used by CloudFront MUST
# live in us-east-1. This aliased provider is used only for the certificate.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}
