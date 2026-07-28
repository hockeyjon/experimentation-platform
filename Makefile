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
INSTANCE_ID      ?= i-0f2138fa43d30ccd7
EC2_USER         ?= ec2-user
EC2_HOST         ?= 3.151.8.246
SSH_KEY          ?= ~/.ssh/experimentation-ec2.pem
REMOTE_DIR       ?= experimentation
COMPOSE          := docker compose -f docker-compose.prod.yml

RSYNC_EXCLUDES := --exclude node_modules --exclude .next --exclude out --exclude .git \
                  --exclude .venv --exclude web --exclude terraform --exclude .env --exclude .DS_Store

.DEFAULT_GOAL := help
.PHONY: help build sync invalidate frontend backend seed deploy ssh ps list-backend logs logs-all logs-fresh logs-reset start stop status

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- frontend --------------------------------------------------------------
build: ## Build the static frontend with the production API URL baked in
	cd web && NEXT_PUBLIC_GRAPHQL_URL="$(API_URL)" npm run build

sync: ## Upload web/out/ to the S3 bucket
	aws s3 sync web/out/ s3://$(BUCKET)/ --delete

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
