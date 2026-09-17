Deployment guide — Docker Compose on AWS EC2

This document covers a simple way to deploy the repo to a single EC2 instance with Docker Compose. It assumes you want the frontend on port 80 and backend on port 8000.

Files in the repo (what matters):
- backend/Dockerfile — builds the FastAPI backend and runs uvicorn
- Frontend/Dockerfile — multi-stage build that produces static assets and serves them with nginx
- docker-compose.yml — runs frontend and backend with a datasets volume mounted from the host
- .env.example — copy to .env and edit before deploy

Quick overview (recommended):
1) Build images on the EC2 host using docker compose, or build locally and push to a registry (ECR) and pull on EC2.
2) Run docker compose up -d on the EC2 instance.
3) Open Security Group ports (80, 8000 if needed). Use a reverse proxy or ALB for TLS in production.

Commands for Amazon Linux 2 or Ubuntu (run as ec2-user or root):

# --- Install Docker & Compose plugin (Amazon Linux 2) ---
# Update packages
sudo yum update -y
# Install Docker
sudo amazon-linux-extras install docker -y || sudo yum install -y docker
sudo service docker start
sudo usermod -aG docker $USER
# Install Docker Compose plugin (if not present)
mkdir -p ~/.docker/cli-plugins
DOCKER_COMPOSE_VERSION="v2.18.1"
curl -SL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" -o ~/.docker/cli-plugins/docker-compose
chmod +x ~/.docker/cli-plugins/docker-compose
# Log out and back in (or new shell) for group changes to take effect

# --- Install Docker & Compose plugin (Ubuntu 22.04+) ---
sudo apt update && sudo apt install -y ca-certificates curl gnupg lsb-release
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
# New shell or re-login required

# --- Deploy the repo on EC2 ---
# 1. Transfer or git clone the repo to the EC2 instance
cd /home/ec2-user
# Example: git clone ...
# git clone <your-repo-url> foreman
cd foreman/SCMGoGo   # adjust path to repo root

# 2. Copy .env.example to .env and edit if necessary
cp .env.example .env
# Edit .env to set FOREMAN_DATASETS_DIR, CORS_ALLOW_ORIGINS etc. (use editor like vim)

# 3. Build and start
# Build and run all services in detached mode
docker compose pull || true   # optional, pulls images if you use a registry
docker compose build --progress=plain
docker compose up -d

# 4. Verify services
docker compose ps
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Ports}}"
curl -fsS http://localhost:8000/health || echo 'backend not healthy'
# Frontend (open in browser): http://<EC2_PUBLIC_IP>/ (port 80 must be open in Security Group)

# 5. Make docker compose auto-start on boot (systemd unit example)
# Create /etc/systemd/system/foreman-stack.service with content below as root
# [Unit]
# Description=Foreman Docker Compose stack
# After=docker.service
# Requires=docker.service
# 
# [Service]
# Type=oneshot
# RemainAfterExit=yes
# WorkingDirectory=/home/ec2-user/foreman/SCMGoGo   # path to repo on EC2
# ExecStart=/usr/bin/docker compose up -d
# ExecStop=/usr/bin/docker compose down
# TimeoutStartSec=0
# 
# [Install]
# WantedBy=multi-user.target

# Then enable and start the unit
sudo systemctl daemon-reload
sudo systemctl enable foreman-stack.service
sudo systemctl start foreman-stack.service

Notes & best practices
- Use a reverse proxy (nginx or AWS ALB) to terminate TLS (HTTPS). Do not expose backend directly to the public internet — prefer to allow only ALB to talk to backend on port 8000.
- For production scale or automatic updates, push images to ECR and pull them from EC2, or use ECS/EKS for managed containers.
- Store sensitive environment variables in AWS Secrets Manager and reference them at deploy-time; do NOT commit secrets to .env in the repo.
- For ML-heavy backend (GPU, large models), choose an EC2 instance with sufficient disk/RAM/GPUs and adapt the backend Dockerfile (CUDA base image) accordingly.
- Monitor containers with logs and set up a log aggregator (CloudWatch / ELK) in production.

If you want, I can:
- Provide a systemd unit file tailored to the exact deploy path you choose on EC2.
- Add a docker-compose.prod.yml that includes an nginx reverse-proxy service and lets you run a single host port 80/443 mapping.
- Add ECR build & push scripts and an IAM role example for pushing images from a CI pipeline.

