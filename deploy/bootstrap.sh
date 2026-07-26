#!/usr/bin/env bash
# One-time setup for a fresh Amazon Linux 2023 instance:
# installs Docker + the Compose plugin, and adds swap (t3.small has only 2 GB RAM,
# and we're running six containers, so a little swap keeps things stable).
set -euo pipefail

echo "==> Installing Docker"
sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user

echo "==> Installing Docker Compose plugin"
sudo mkdir -p /usr/libexec/docker/cli-plugins
sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/libexec/docker/cli-plugins/docker-compose
sudo chmod +x /usr/libexec/docker/cli-plugins/docker-compose

echo "==> Installing Docker Buildx plugin (Compose needs it to build images)"
BUILDX_VER=$(curl -s https://api.github.com/repos/docker/buildx/releases/latest | grep '"tag_name"' | cut -d'"' -f4)
sudo curl -SL "https://github.com/docker/buildx/releases/download/${BUILDX_VER}/buildx-${BUILDX_VER}.linux-amd64" \
  -o /usr/libexec/docker/cli-plugins/docker-buildx
sudo chmod +x /usr/libexec/docker/cli-plugins/docker-buildx

echo "==> Adding 2 GB swap"
if [ ! -f /swapfile ]; then
  sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo ""
echo "Bootstrap complete:"
docker --version
docker compose version
echo ""
echo "IMPORTANT: log out and back in once (so your user picks up the docker group),"
echo "then run the compose command."
