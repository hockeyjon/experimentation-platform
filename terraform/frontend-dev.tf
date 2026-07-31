# ---------------------------------------------------------------------------
# DEV frontend (Phase 2 blue-green) — a throwaway mirror of the prod frontend,
# served at devexperimentation.gunbarrelstudio.com and pointed at the dev API
# (api-dev). Same private-S3 + CloudFront(OAC) shape as frontend.tf; its own
# cert, bucket, and distribution so nothing here touches prod.
#
# First run is two-phase, same as the prod cert (DNS lives at GoDaddy):
#   1) terraform apply -target=aws_acm_certificate.frontend_dev
#   2) add the CNAME from `terraform output dev_acm_validation_record` at GoDaddy
#   3) terraform apply            (finishes validation + bucket + distribution)
#   4) point the `devexperimentation` CNAME at `dev_cloudfront_domain` at GoDaddy
#
# Teardown after cutover:
#   terraform destroy \
#     -target=aws_cloudfront_distribution.frontend_dev \
#     -target=aws_s3_bucket_policy.frontend_dev \
#     -target=aws_s3_bucket.frontend_dev \
#     -target=aws_cloudfront_origin_access_control.frontend_dev \
#     -target=aws_acm_certificate_validation.frontend_dev \
#     -target=aws_acm_certificate.frontend_dev
# (empty the bucket first: aws s3 rm s3://<dev bucket> --recursive)
# ---------------------------------------------------------------------------

locals {
  dev_frontend_fqdn = "devexperimentation.${var.domain}"
  dev_bucket_name   = "${var.bucket_name}-dev"
}

# --- cert (us-east-1, required for CloudFront) ---
resource "aws_acm_certificate" "frontend_dev" {
  provider          = aws.us_east_1
  domain_name       = local.dev_frontend_fqdn
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "frontend_dev" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.frontend_dev.arn
}

# --- private bucket ---
resource "aws_s3_bucket" "frontend_dev" {
  bucket = local.dev_bucket_name
}

resource "aws_s3_bucket_public_access_block" "frontend_dev" {
  bucket                  = aws_s3_bucket.frontend_dev.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- CloudFront (OAC to the private bucket) ---
resource "aws_cloudfront_origin_access_control" "frontend_dev" {
  name                              = "${local.dev_bucket_name}-oac"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "frontend_dev" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [local.dev_frontend_fqdn]
  price_class         = "PriceClass_100"
  comment             = "Experimentation frontend (DEV / Phase 2)"

  origin {
    domain_name              = aws_s3_bucket.frontend_dev.bucket_regional_domain_name
    origin_id                = "s3origin"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend_dev.id
  }

  default_cache_behavior {
    target_origin_id       = "s3origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
  }

  # SPA-friendly: serve index.html (200) for not-found paths instead of S3 XML errors.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 10
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend_dev.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Bucket policy: allow ONLY the dev distribution to read objects.
data "aws_iam_policy_document" "frontend_dev_bucket" {
  statement {
    sid       = "AllowCloudFrontOAC"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.frontend_dev.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend_dev.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "frontend_dev" {
  bucket = aws_s3_bucket.frontend_dev.id
  policy = data.aws_iam_policy_document.frontend_dev_bucket.json
}

# --- outputs ---
output "dev_acm_validation_record" {
  description = "Add this CNAME at GoDaddy to validate the dev cert (strip the domain from Name, drop trailing dots)."
  value = {
    for o in aws_acm_certificate.frontend_dev.domain_validation_options :
    o.domain_name => {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  }
}

output "dev_cloudfront_domain" {
  description = "GoDaddy: point the `devexperimentation` CNAME at this."
  value       = aws_cloudfront_distribution.frontend_dev.domain_name
}

output "dev_cloudfront_distribution_id" {
  description = "Use for cache invalidations after each dev frontend deploy."
  value       = aws_cloudfront_distribution.frontend_dev.id
}

output "dev_bucket_name" {
  description = "Sync the dev-built frontend (web/out/) here."
  value       = aws_s3_bucket.frontend_dev.bucket
}
