# Provisioner image — Node + kubectl. kubectl uses the in-cluster ServiceAccount automatically.
FROM node:22-slim

# kubectl (pinned to the cluster's minor version is ideal; latest stable is fine for the demo).
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" -o /usr/local/bin/kubectl \
  && chmod +x /usr/local/bin/kubectl \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# The per-session stack it applies (k8s/phase2/session-stack.yaml) is NOT baked in — it's mounted
# from a ConfigMap at STACK_PATH (see k8s/phase2/provisioner.yaml), so you can tune the session
# stack without rebuilding this image.

EXPOSE 8090
CMD ["npm", "run", "start"]
