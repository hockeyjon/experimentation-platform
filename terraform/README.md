# Terraform — Experimentation platform infrastructure

Provisions the AWS infrastructure: the private **S3 bucket**, **CloudFront** distribution
(OAC-locked), **ACM certificate**, the **EC2** instance (with Docker bootstrap), its
**security group**, **Elastic IP**, and the **SSH key pair** (generated here, private key
written to `~/.ssh`).

## What this DOES and does NOT manage

| Managed by Terraform | NOT managed (stays manual / CLI) |
|---|---|
| S3 bucket + public-access block + bucket policy | **GoDaddy DNS records** — Terraform can't touch GoDaddy. It *outputs* the values to paste in. |
| CloudFront distribution + Origin Access Control | **Static file upload** (`make sync`) — content, not infra. |
| ACM certificate (us-east-1) | **CloudFront invalidation** after deploys (`make invalidate`). |
| EC2 instance (Docker/swap bootstrap) + security group | **App deploy** (`make backend` — rsync + `docker compose up`). |
| Elastic IP + SSH key pair | — |

Why the split: Terraform manages *infrastructure state*. Uploading a build folder and
busting a CDN cache are deploy steps (see the Makefile), and the DNS registrar is GoDaddy,
not Route 53.

## Prerequisites

- Terraform ≥ 1.5 and AWS credentials configured.
- Lock SSH to your IP (the default `0.0.0.0/0` is open to the world):

```bash
echo "ssh_ingress_cidr = \"$(curl -s https://checkip.amazonaws.com)/32\"" > terraform.tfvars
```

## Apply (two-phase, because ACM validates through GoDaddy)

```bash
terraform init

# 1) Create just the certificate
terraform apply -target=aws_acm_certificate.frontend

# 2) Read the validation record and add it as a CNAME at GoDaddy
#    (strip ".<domain>" from the Name, drop trailing dots)
terraform output acm_validation_record

# 3) Build everything else — blocks until the cert validates, then creates
#    CloudFront, EC2, and the key pair (written to ~/.ssh/<key_name>.pem).
terraform apply
```

## Finish the wiring (from the outputs)

```bash
terraform output
```

- **GoDaddy:** add CNAME `<frontend_subdomain>` → `cloudfront_domain`; point the A record
  `api` → `api_public_ip`.
- **Deploy:** from the project root, set the Makefile's `DISTRIBUTION_ID`, `INSTANCE_ID`,
  and `EC2_HOST` from the outputs, then `make backend && make seed && make frontend`.

## Variables

See `variables.tf`. Common overrides: `region`, `domain`, `frontend_subdomain`,
`bucket_name` (must be globally unique), `instance_type`, `ssh_ingress_cidr`, `key_name`.

## Teardown

```bash
terraform destroy
```

Empties/deletes the bucket, disables + deletes the CloudFront distribution, terminates the
instance, and releases the Elastic IP. Remove the GoDaddy records by hand afterward.
