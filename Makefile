# Experimentation platform — deploy automation.
#
# Wraps the non-Terraform steps: build + ship the frontend to S3/CloudFront, and
# sync + rebuild the backend on EC2. Override any variable on the command line, e.g.
#   make frontend BUCKET=my-bucket
#
# Common usage:
#   make deploy        # frontend + backend
#   make frontend      # build -> s3 sync -> cloudfront invalidation
#   make backend       # rsync code to EC2 -> docker compose up --build
#   make stop / start  # save money when idle
#   make help          # list everything

SHELL := /bin/bash

# --- config (override on the CLI or via environment) -----------------------
API_URL          ?= https://api.gunbarrelstudio.com/
BUCKET           ?= gunbarrelstudio-experimentation-web
DISTRIBUTION_ID  ?= E2DYGW2SI4X3N0
REGION           ?= us-east-2
INSTANCE_ID      ?= i-06428a5ce78518cea # the Phase 2 box (prod since the cutover EIP swap)
EC2_USER         ?= ec2-user
EC2_HOST         ?= 3.151.8.246
SSH_KEY          ?= ~/.ssh/experimentation-ec2.pem
REMOTE_DIR       ?= experimentation
COMPOSE          := docker compose -f docker-compose.prod.yml

# --- dev environment (Phase 2 blue-green: devexperimentation + api-dev, own bucket + CDN) ---
DEV_API_URL          ?= https://api-dev.gunbarrelstudio.com/
DEV_BUCKET           ?= gunbarrelstudio-experimentation-web-dev
DEV_DISTRIBUTION_ID  ?= E25MYRGN4D1A30
DEV_EC2_HOST         ?= 3.132.245.212
LOCAL_PORT       ?= 8080
WEB_PORT         ?= 3000
# WEB_ORIGIN must follow WEB_PORT: it becomes logstream's ALLOWED_ORIGIN, so a dev server
# on another port would otherwise be refused by the Backend tab's endpoints.
LOCAL_COMPOSE    := LOCAL_PORT=$(LOCAL_PORT) WEB_ORIGIN=http://localhost:$(WEB_PORT) \
                    docker compose -f deploy/docker-compose.local.yml

RSYNC_EXCLUDES := --exclude node_modules --exclude .next --exclude out --exclude .git \
                  --exclude .venv --exclude web --exclude terraform --exclude .env --exclude .DS_Store

.DEFAULT_GOAL := help
.PHONY: help build sync invalidate frontend frontend-dev backend seed deploy ssh ps list-backend logs logs-all logs-fresh logs-reset start stop status \
        local-up local-seed local-web local-web-stop local-bounce local-logs local-ps local-down

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- frontend --------------------------------------------------------------
build: ## Build the static frontend with the production API URL baked in
	cd web && NEXT_PUBLIC_GRAPHQL_URL="$(API_URL)" npm run build

# Two passes, because the two kinds of file want opposite caching. Chunk filenames under
# _next/static are content-hashed, so they're immutable and safe to cache forever. The HTML
# is NOT hashed and must revalidate on every load — served without a Cache-Control header it
# falls into browser heuristic caching, which pins visitors to an old build's chunk hashes
# long after `make invalidate` has cleared CloudFront (an invalidation can't reach a browser).
# Assets upload first so the new HTML never references a chunk that isn't in the bucket yet.
sync: ## Upload web/out/ to S3 (immutable hashed assets, always-revalidate HTML)
	aws s3 sync web/out/_next/static/ s3://$(BUCKET)/_next/static/ \
		--cache-control "public,max-age=31536000,immutable"
	aws s3 sync web/out/ s3://$(BUCKET)/ --delete \
		--exclude "_next/static/*" \
		--cache-control "no-cache"

invalidate: ## Bust the CloudFront cache, then poll until the invalidation completes
	@id=$$(aws cloudfront create-invalidation --distribution-id $(DISTRIBUTION_ID) --paths "/*" --query 'Invalidation.Id' --output text); \
	echo "Created invalidation $$id"; \
	while true; do \
		status=$$(aws cloudfront get-invalidation --distribution-id $(DISTRIBUTION_ID) --id $$id --query 'Invalidation.Status' --output text); \
		echo "  $$(date +%H:%M:%S)  status: $$status"; \
		[ "$$status" = "Completed" ] && break; \
		sleep 10; \
	done; \
	echo "✓ Invalidation $$id complete."

frontend: ## Full frontend deploy: build -> sync -> invalidate
	$(MAKE) build
	$(MAKE) sync
	$(MAKE) invalidate

frontend-dev: ## Deploy the frontend to the DEV env (Phase 2): dev API baked in -> dev bucket -> dev CDN
	$(MAKE) frontend API_URL=$(DEV_API_URL) BUCKET=$(DEV_BUCKET) DISTRIBUTION_ID=$(DEV_DISTRIBUTION_ID)

.PHONY: maintenance
maintenance: ## Put the static "under construction" page at the site root (S3 only, no EC2)
	aws s3 cp web/maintenance/index.html s3://$(BUCKET)/index.html \
		--content-type "text/html; charset=utf-8" --cache-control "no-cache"
	$(MAKE) invalidate
	@echo "✓ Maintenance page live at https://experimentation.gunbarrelstudio.com/ — restore with: make frontend"

# --- backend ---------------------------------------------------------------
# Caddy is recreated explicitly on every deploy. rsync replaces ./Caddyfile with a NEW
# inode, and Docker's single-file bind mount follows the inode the container started with —
# so `up -d` alone leaves caddy serving the old routes indefinitely (a `caddy reload` can't
# help either: the file *inside* the container really is the stale one).
backend: ## Deploy backend: rsync code to EC2 and rebuild the Docker stack
	rsync -avz --delete $(RSYNC_EXCLUDES) -e "ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new" ./ $(EC2_USER)@$(EC2_HOST):$(REMOTE_DIR)/
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) up -d --build && $(COMPOSE) up -d --force-recreate caddy"

seed: ## Seed the production database (sample experiments + simulated traffic)
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) exec -T api npm run seed"

# --- combined --------------------------------------------------------------
deploy: ## Full deploy: frontend + backend
	$(MAKE) frontend
	$(MAKE) backend

# --- local full stack ------------------------------------------------------
# Runs everything the EC2 box runs — api, stats, logstream, Caddy, datastores — on your
# machine, so the Backend tab (log streaming + health check) works without deploying. The
# app services must be CONTAINERS for that tab to have anything to stream or list, which is
# why this exists alongside the datastore-only root docker-compose.yml.
local-up: ## Start the full stack locally (http://localhost:8080), then `make local-seed`
	$(LOCAL_COMPOSE) up -d --build
	@echo ""
	@echo "  backend ready on http://localhost:$(LOCAL_PORT)"
	@echo "  next:  make local-seed     # sample experiments (the DB starts empty)"
	@echo "         make local-web      # Next.js dev server on http://localhost:3000"

local-seed: ## Seed the local database with sample experiments + traffic
	$(LOCAL_COMPOSE) exec -T api npm run seed

# The dev server runs on the host, so `make local-down` does NOT stop it — leaving it to
# collide with the next `make local-web`. Fail with the culprit named rather than a bare
# EADDRINUSE stack trace.
local-web: ## Run the Next.js dev server against the local stack (hot reload)
	@pid=$$(lsof -nP -iTCP:$(WEB_PORT) -sTCP:LISTEN -t 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then \
		echo "Port $(WEB_PORT) is already in use by PID $$pid:"; \
		ps -o command= -p $$pid | sed 's/^/    /'; \
		echo ""; \
		echo "  It may already be serving this app — try http://localhost:$(WEB_PORT) first."; \
		echo "  Otherwise:  make local-web-stop        (stop it)"; \
		echo "              make local-web WEB_PORT=3001   (use another port)"; \
		exit 1; \
	fi; \
	cd web && NEXT_PUBLIC_GRAPHQL_URL=http://localhost:$(LOCAL_PORT)/ npx next dev -p $(WEB_PORT)

# One command to get back to a known-good localhost:$(WEB_PORT): stop the dev server (which
# local-down can't, being a host process), replace the stack, wait for the api to actually
# serve, reseed, then run the dev server in the foreground. Ctrl+C stops the dev server and
# leaves the backend up. Add CLEAN=1 to drop the data volumes as well.
local-bounce: ## Restart everything local and hand back a clean dev server (CLEAN=1 drops volumes)
	-@$(MAKE) local-web-stop
	@$(MAKE) local-down
	@$(MAKE) local-up
	@printf "  waiting for the api to serve"; \
	for i in $$(seq 1 60); do \
		code=$$(curl -s -o /dev/null -w '%{http_code}' -m 3 -XPOST \
			-H 'Content-Type: application/json' -d '{"query":"{__typename}"}' \
			http://localhost:$(LOCAL_PORT)/ 2>/dev/null); \
		if [ "$$code" = "200" ]; then echo " → ready"; break; fi; \
		printf "."; sleep 2; \
	done; \
	if [ "$$code" != "200" ]; then echo " → gave up (last HTTP $$code)"; fi
	@$(MAKE) local-seed
	@echo ""
	@echo "  starting the dev server — http://localhost:$(WEB_PORT)  (Ctrl+C to stop)"
	@echo "  note: the enrolled-customer board lives in your browser's localStorage."
	@echo "        Hard-refresh, or use the Backend tab's Restart, to clear it too."
	@$(MAKE) local-web

local-web-stop: ## Stop the Next.js dev server holding the web port
	@pid=$$(lsof -nP -iTCP:$(WEB_PORT) -sTCP:LISTEN -t 2>/dev/null | head -1); \
	if [ -n "$$pid" ]; then kill $$pid && echo "stopped PID $$pid on port $(WEB_PORT)"; \
	else echo "nothing listening on port $(WEB_PORT)"; fi

local-logs: ## Tail the local app-flow logs (api + stats)
	$(LOCAL_COMPOSE) logs -f --tail=100 api stats

local-ps: ## Show the local stack's containers
	$(LOCAL_COMPOSE) ps

local-down: ## Stop the local stack (CLEAN=1 also drops its data volumes)
	$(LOCAL_COMPOSE) down $(if $(CLEAN),--volumes,)

# --- ops helpers -----------------------------------------------------------
ssh: ## Open an SSH session on the instance
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST)

ps: ## Show the status of the backend containers
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) ps"

list-backend: ## List the Docker containers running on the EC2 instance (host-wide, not just the compose stack)
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) \
		"printf '\n\n'; docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}';printf '\n\n'"

logs: ## Tail the app-flow logs only (api + stats — no datastore noise)
	ssh -t -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) logs -f --tail=100 api stats"

logs-all: ## Tail ALL container logs (api, stats, caddy, postgres, mongo, redis)
	ssh -t -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) logs -f --tail=100"

logs-fresh: ## Tail app logs from NOW (no history) — clean view for a demo, deletes nothing
	ssh -t -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) logs -f --tail=0 api stats"

logs-reset: ## Actually WIPE api+stats logs by recreating those containers (brief API blip)
	ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST) "cd $(REMOTE_DIR)/deploy && $(COMPOSE) up -d --force-recreate api stats && echo 'api + stats recreated — logs cleared'"

start: ## Start the EC2 instance
	aws ec2 start-instances --instance-ids $(INSTANCE_ID) --region $(REGION) \
		--query "StartingInstances[0].CurrentState.Name" --output text

stop: ## Stop the EC2 instance (save money when idle)
	aws ec2 stop-instances --instance-ids $(INSTANCE_ID) --region $(REGION) \
		--query "StoppingInstances[0].CurrentState.Name" --output text

status: ## Show the EC2 instance power state
	aws ec2 describe-instances --instance-ids $(INSTANCE_ID) --region $(REGION) \
		--query "Reservations[0].Instances[0].State.Name" --output text

# --- k3s (Phase 1: single-namespace migration; Caddy stays the edge) --------
# These do NOT run as part of `make deploy`. The compose stack stays the live system
# until you deliberately cut over. First cutover:
#   make k3s-install     # one time: install k3s (Traefik disabled so Caddy owns 80/443)
#   make k8s-deploy      # sync code -> build+import images -> apply manifests
# Roll back any time with `make backend` (compose) — nothing here removes it.
K8S_IMAGES := api stats logstream
KUBECTL    := sudo k3s kubectl
SSHC        = ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new $(EC2_USER)@$(EC2_HOST)

.PHONY: k3s-install k8s-sync k8s-images k8s-apply k8s-deploy k8s-status k8s-logs

k3s-install: ## One-time: install k3s on the instance, Traefik disabled (Caddy is the edge)
	$(SSHC) "curl -sfL https://get.k3s.io | sh -s - --disable traefik --write-kubeconfig-mode 644"

k8s-sync: ## rsync the repo to the instance (same excludes as the compose backend deploy)
	rsync -avz --delete $(RSYNC_EXCLUDES) -e "ssh -i $(SSH_KEY) -o StrictHostKeyChecking=accept-new" ./ $(EC2_USER)@$(EC2_HOST):$(REMOTE_DIR)/

k8s-images: ## Build the app images on the instance and import them into k3s's containerd
	# Single-quoted so the loop variable is expanded by the REMOTE shell, not locally.
	$(SSHC) 'cd $(REMOTE_DIR) && for s in $(K8S_IMAGES); do docker build -t experimentation-$$s:latest $$s && docker save experimentation-$$s:latest | sudo k3s ctr images import -; done'

k8s-apply: ## Apply the manifests (idempotent)
	$(SSHC) "cd $(REMOTE_DIR) && $(KUBECTL) apply -f k8s/"

k8s-deploy: k8s-sync k8s-images k8s-apply ## Full k3s deploy: sync -> build+import images -> apply -> restart app pods
	# `:latest` + IfNotPresent means apply alone won't restart pods to pick up rebuilt images —
	# roll the app Deployments so they pull in the freshly-imported images from containerd.
	$(SSHC) "$(KUBECTL) -n experimentation rollout restart deploy/api deploy/stats deploy/logstream && $(KUBECTL) -n experimentation rollout status deploy/api --timeout=150s"

k8s-status: ## Show the k3s workloads (pods, services, volumes)
	$(SSHC) "$(KUBECTL) -n experimentation get pods,svc,pvc -o wide"

k8s-logs: ## Tail the api + stats pods
	$(SSHC) -t "$(KUBECTL) -n experimentation logs -l 'app in (api,stats)' -f --max-log-requests 6 --tail=100"
