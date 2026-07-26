variable "region" {
  description = "Primary AWS region for S3 + EC2."
  type        = string
  default     = "us-east-2"
}

variable "domain" {
  description = "Root domain (registered at GoDaddy)."
  type        = string
  default     = "gunbarrelstudio.com"
}

variable "frontend_subdomain" {
  description = "Subdomain for the static app -> CloudFront."
  type        = string
  default     = "experimentation"
}

variable "api_subdomain" {
  description = "Subdomain for the API -> EC2."
  type        = string
  default     = "api"
}

variable "bucket_name" {
  description = "Globally-unique S3 bucket name for the static frontend."
  type        = string
  default     = "gunbarrelstudio-experimentation-web"
}

variable "instance_type" {
  description = "EC2 instance size. t3.small = 2 GB RAM."
  type        = string
  default     = "t3.small"
}

variable "root_volume_gb" {
  description = "Root EBS volume size in GB."
  type        = number
  default     = 20
}

variable "ssh_ingress_cidr" {
  description = "CIDR allowed to SSH (port 22). Lock this to your IP, e.g. \"1.2.3.4/32\"."
  type        = string
  default     = "0.0.0.0/0"
}

variable "key_name" {
  description = "Name for the EC2 key pair that Terraform creates."
  type        = string
  default     = "experimentation-ec2"
}

locals {
  frontend_fqdn = "${var.frontend_subdomain}.${var.domain}"
  api_fqdn      = "${var.api_subdomain}.${var.domain}"
}
