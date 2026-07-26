# Everything you need to finish the wiring at GoDaddy + deploys.

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

output "api_public_ip" {
  description = "GoDaddy: point the `api` A record at this Elastic IP."
  value       = aws_eip.backend.public_ip
}

output "instance_id" {
  description = "EC2 instance id (for the Makefile start/stop targets)."
  value       = aws_instance.backend.id
}

output "bucket_name" {
  description = "Sync your built frontend (web/out/) here."
  value       = aws_s3_bucket.frontend.bucket
}

output "ssh_key_path" {
  description = "Terraform wrote the private key here (chmod 400)."
  value       = local_sensitive_file.ec2_pem.filename
}

output "ssh_command" {
  description = "SSH into the new instance."
  value       = "ssh -i ${local_sensitive_file.ec2_pem.filename} ec2-user@${aws_eip.backend.public_ip}"
}
