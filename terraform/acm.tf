# TLS certificate for the CloudFront frontend. Must be created in us-east-1.
# Equivalent to: aws acm request-certificate --domain-name experimentation.gunbarrelstudio.com ...
resource "aws_acm_certificate" "frontend" {
  provider          = aws.us_east_1
  domain_name       = local.frontend_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# DNS lives at GoDaddy, not Route 53, so Terraform cannot create the validation
# record. Read it from the `acm_validation_record` output, add it at GoDaddy, and
# this resource then blocks until ACM reports the cert ISSUED.
#
# Because of this manual step, a clean first run is two-phase:
#   1) terraform apply -target=aws_acm_certificate.frontend
#   2) add the CNAME from `terraform output acm_validation_record` at GoDaddy
#   3) terraform apply        (finishes validation + everything else)
resource "aws_acm_certificate_validation" "frontend" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.frontend.arn
}
