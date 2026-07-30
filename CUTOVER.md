# Phase 1 → Phase 2 cutover runbook (blue-green via Elastic IP swap)

Build & prove Phase 2 on a parallel dev box, then cut prod over by **moving the prod Elastic
IP** to the Phase 2 box (same IP → no DNS wait), keeping Phase 1 up as instant rollback until
confident, then decommission.

## Known values (prod, today)
- Prod EC2 instance: `i-0f2138fa43d30ccd7`
- Prod Elastic IP: `3.151.8.246` — allocation `eipalloc-08a8728c1ccec4172`
- Region: `us-east-2`
- Prod frontend: `experimentation.gunbarrelstudio.com` — S3 `gunbarrelstudio-experimentation-web`, CloudFront `E2DYGW2SI4X3N0`
- Prod API: `api.gunbarrelstudio.com` → the prod EIP (Caddy on the EC2 box)

## Dev / Phase 2 box (provisioned)
- Dev EC2 instance (`<p2-instance-id>`): `i-06428a5ce78518cea` — t3.medium, us-east-2c, Amazon Linux 2023
- Dev Elastic IP (`<dev-eip-alloc>`): `3.132.245.212` — allocation `eipalloc-082ff28376bf2fe8a`
- Same key (`experimentation-ec2`) and security group (`experimentation-backend-sg`) as prod

---

## Phase A — stand up the dev/Phase-2 environment (no prod impact)

1. **Launch a 2nd EC2** (t3.medium or large), same base as prod (Amazon Linux, Docker, SSH key).
2. **Allocate + associate a dev Elastic IP:**
   ```bash
   aws ec2 allocate-address --region us-east-2 --query AllocationId --output text     # → <dev-eip-alloc>
   aws ec2 associate-address --region us-east-2 --instance-id <p2-instance-id> --allocation-id <dev-eip-alloc>
   ```
3. **DNS (GoDaddy):**
   - `api-dev.gunbarrelstudio.com` → the dev EIP (A record)
   - `devexperimentation.gunbarrelstudio.com` → the dev CloudFront distribution (CNAME)
4. **Dev backend:** install k3s, deploy Phase 1 stack, then the Phase 2 pieces (provisioner,
   session stack, `deploy/Caddyfile.phase2`). Dev Caddy serves `api-dev.gunbarrelstudio.com`.
5. **Dev frontend:** new S3 bucket + CloudFront + ACM cert for `devexperimentation…`; build with
   `NEXT_PUBLIC_GRAPHQL_URL=https://api-dev.gunbarrelstudio.com/` and deploy.
6. **Prove Phase 2 end-to-end on dev** (work the PHASE2.md checklist here — it's the safe place).

---

## Phase B — cutover (prod → Phase 2). Do NOT terminate Phase 1 yet.

**Pre-flight:** Phase 2 fully verified on dev; a recent DB isn't a concern (sessions are ephemeral).

1. **Point the Phase 2 box's Caddy at the prod domain.** Edit its Caddyfile so the site block is
   `api.gunbarrelstudio.com` (keep `api-dev` too if you want both). Caddy can't get the prod cert
   until the EIP lands on it — that's the next step; Caddy will retry ACME automatically.
2. **Swap the prod Elastic IP onto the Phase 2 box** (atomic reassociation — disassociates from
   Phase 1 and associates to Phase 2):
   ```bash
   aws ec2 associate-address --region us-east-2 \
     --instance-id <p2-instance-id> \
     --allocation-id eipalloc-08a8728c1ccec4172 \
     --allow-reassociation
   ```
   `api.gunbarrelstudio.com` now resolves to the Phase 2 box (same IP, no DNS propagation).
3. **Let Caddy obtain the prod cert** (~30s once traffic for `api.gunbarrelstudio.com` reaches it):
   ```bash
   ssh … <p2-box> "sudo k3s kubectl -n experimentation logs deploy/caddy --tail=20 | grep -i 'certificate obtained'"
   ```
4. **Deploy the Phase 2 frontend to the PROD bucket** (same S3/CloudFront; the app still calls
   `api.gunbarrelstudio.com`, now the Phase 2 box):
   ```bash
   cd experimentation-platform && git checkout <phase2-branch> && make frontend
   ```
5. **Verify prod on Phase 2:**
   ```bash
   curl -s -X POST https://api.gunbarrelstudio.com/ -H 'content-type: application/json' \
     -d '{"query":"{ __typename }"}'
   # load https://experimentation.gunbarrelstudio.com and exercise the create-session flow
   ```

### Rollback (any time before decommission)
Swap the EIP back and redeploy the Phase 1 frontend:
```bash
aws ec2 associate-address --region us-east-2 \
  --instance-id i-0f2138fa43d30ccd7 \
  --allocation-id eipalloc-08a8728c1ccec4172 --allow-reassociation
git checkout <phase1-commit> && make frontend
```
This is why Phase 1 stays up through Phase B — instant, IP-level rollback.

---

## Phase C — decommission Phase 1 + cleanup (once confident, e.g. a day later)

1. **Terminate the Phase 1 instance:**
   ```bash
   aws ec2 terminate-instances --region us-east-2 --instance-ids i-0f2138fa43d30ccd7
   ```
2. **Release the dev Elastic IP** (stops the ~$3.65/mo idle charge):
   ```bash
   aws ec2 disassociate-address --region us-east-2 --allocation-id <dev-eip-alloc>   # if still associated
   aws ec2 release-address     --region us-east-2 --allocation-id <dev-eip-alloc>
   ```
3. **Update `Makefile` vars** to the Phase 2 box: `INSTANCE_ID := <p2-instance-id>`. `EC2_HOST`
   stays `3.151.8.246` (the EIP moved, the IP didn't). `SSH_KEY` if the new box uses a different key.
4. **Optional:** tear down the dev frontend (`devexperimentation` S3/CloudFront/cert + DNS) and the
   `api-dev` DNS record — or keep them as a standing dev environment for future work.

## Gotchas
- **Both edges want 80/443:** never run the compose stack and k3s on the same box at once (you hit
  this in Phase 1). N/A across two boxes, but relevant if you rebuild.
- **Let's Encrypt rate limit:** 5 certs/week per exact domain. If you've re-issued `api.gunbarrelstudio.com`
  a lot during testing, the cutover cert could be throttled — check before, not during.
- **Frontend API base is build-time:** dev builds with `api-dev`, prod builds with `api`. The Phase 2
  cutover frontend must be built with the prod `NEXT_PUBLIC_GRAPHQL_URL` (its default) — don't ship a
  dev-pointed bundle to prod.
