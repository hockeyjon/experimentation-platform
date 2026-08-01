# Frontend wiring (GoDaddy + deploys). The backend EC2/EIP/SG/key are hand-managed (not
# Terraform) since the prod box was built out by hand (k3s + Phase 2) — see CUTOVER.md.

output "acm_validation_record" {
  description = "Add this CNAME at GoDaddy to validate the certificate (strip the domain from Name, drop trailing dots)."
  value = {
    for o in aws_acm_certificate.frontend.domain_validation_options :
    o.domain_name => {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  }
}

output "cloudfront_domain" {
  description = "GoDaddy: point the `experimentation` CNAME at this."
  value       = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_distribution_id" {
  description = "Use for cache invalidations after each frontend deploy."
  value       = aws_cloudfront_distribution.frontend.id
}

output "bucket_name" {
  description = "Sync your built frontend (web/out/) here."
  value       = aws_s3_bucket.frontend.bucket
}
