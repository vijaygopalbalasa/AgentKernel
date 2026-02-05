# Installation Guide

This guide covers how to install and set up AgentKernel for development and production use.

## Prerequisites

### Required Software

- **Node.js 20+** (22+ recommended)
- **pnpm 9+** — Package manager
- **PostgreSQL 15+** — Primary database
- **Redis 7+** — Event bus and caching (optional for development)

### Optional Software

- **Docker** — For containerized deployment
- **Qdrant** — Vector database for memory features

## Quick Start (Development)

### 1. Clone and Install

```bash
git clone https://github.com/vijaygopalbalasa/AgentKernel.git
cd AgentKernel
pnpm install
```

### 2. Set Up Environment

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your configuration:

```env
# Security (required for capability tokens)
PERMISSION_SECRET=your-32-char-secret-for-hmac-signing

# Database
DATABASE_HOST=localhost
DATABASE_PORT=5433
DATABASE_NAME=agentkernel_test
DATABASE_USER=agentkernel
DATABASE_PASSWORD=agentkernel_test
```

### 3. Build and Test

```bash
# Build all packages
pnpm build

# Run tests
pnpm test
```

### 4. Start Development Server

```bash
# Use the CLI directly after building
node packages/agentkernel-cli/dist/cli.js start

# Or install globally
npm install -g @agentkernel/agent-kernel
agentkernel init
agentkernel start
```

Once running, test with curl:

```bash
curl http://localhost:18788/health
curl -X POST http://localhost:18788/evaluate \
  -H "Content-Type: application/json" \
  -d '{"tool":"read","args":{"path":"/home/user/.ssh/id_rsa"}}'
```

## Docker Quick Start

### Using Docker Compose

The fastest way to get a complete AgentKernel environment:

```bash
# Start PostgreSQL and Redis
docker compose -f docker/docker-compose.test.yml up -d

# Install dependencies
pnpm install

# Build packages
pnpm build

# Run the CLI
node packages/agentkernel-cli/dist/cli.js start
```

### Docker Compose Configuration

The `docker/docker-compose.test.yml` provides:

- PostgreSQL 16 on port 5433
- Redis 7 on port 6380
- Qdrant (optional) on port 6335

```yaml
services:
  postgres-test:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: agentkernel
      POSTGRES_PASSWORD: agentkernel_test
      POSTGRES_DB: agentkernel_test
    ports:
      - "5433:5432"

  redis-test:
    image: redis:7-alpine
    ports:
      - "6380:6379"

  qdrant-test:
    image: qdrant/qdrant:v1.13.6
    ports:
      - "6335:6333"
```

## Production Installation

### 1. System Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 2 cores | 4+ cores |
| RAM | 4 GB | 8+ GB |
| Disk | 20 GB | 50+ GB |
| Network | 100 Mbps | 1 Gbps |

### 2. Database Setup

#### PostgreSQL

```bash
# Create database and user
sudo -u postgres psql << EOF
CREATE USER agentkernel WITH PASSWORD 'your-secure-password';
CREATE DATABASE agentkernel OWNER agentkernel;
GRANT ALL PRIVILEGES ON DATABASE agentkernel TO agentkernel;
EOF
```

#### Redis

```bash
# Install Redis (Ubuntu/Debian)
sudo apt install redis-server

# Configure for production
sudo sed -i 's/^# requirepass .*/requirepass your-redis-password/' /etc/redis/redis.conf
sudo systemctl restart redis
```

### 3. Application Setup

```bash
# Clone repository
git clone https://github.com/vijaygopalbalasa/AgentKernel.git
cd AgentKernel

# Install production dependencies
pnpm install --prod

# Build for production
NODE_ENV=production pnpm build
```

### 4. Environment Configuration

Create `/etc/agentkernel/config.env`:

```env
NODE_ENV=production

# Database
DATABASE_URL=postgresql://agentkernel:your-secure-password@localhost:5432/agentkernel

# Redis
REDIS_URL=redis://:your-redis-password@localhost:6379

# LLM API Keys
ANTHROPIC_API_KEY=sk-ant-...

# Security
AGENTKERNEL_PRODUCTION_HARDENING=true

# Logging
LOG_LEVEL=info
```

### 5. Systemd Service

Create `/etc/systemd/system/agentkernel.service`:

```ini
[Unit]
Description=AgentKernel Security Proxy
After=network.target postgresql.service redis.service

[Service]
Type=simple
User=agentkernel
Group=agentkernel
WorkingDirectory=/opt/agentkernel
EnvironmentFile=/etc/agentkernel/config.env
ExecStart=/usr/local/bin/agentkernel start --policy /etc/agentkernel/policy.yaml --port 18788
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable agentkernel
sudo systemctl start agentkernel
```

## Package Installation

### Installing Individual Packages

Each package can be installed separately via npm:

```bash
# Core kernel (database, logging, shutdown handling)
npm install @agentkernel/kernel

# Runtime (state machine, sandbox, policies)
npm install @agentkernel/runtime

# LangChain adapter
npm install @agentkernel/langchain-adapter

# CLI tool (global binary)
npm install -g @agentkernel/agent-kernel
```

### Peer Dependencies

Some packages require peer dependencies:

| Package | Peer Dependencies |
|---------|-------------------|
| `@agentkernel/langchain-adapter` | `@langchain/core >=0.2.0` |
| `@agentkernel/kernel` | `pg >=8.0.0`, `ioredis >=5.0.0` |

## Verification

### Check Installation

```bash
# Verify build
pnpm build

# Run all tests
pnpm test

# Check CLI
agentkernel --help
```

### Health Check

```bash
# Check proxy status
agentkernel status

# View recent audit logs
agentkernel audit --limit 10

# Or via HTTP when proxy is running
curl http://localhost:18788/health
```

## Troubleshooting

### Common Issues

#### Build Errors

```bash
# Clear node_modules and reinstall
rm -rf node_modules packages/*/node_modules
pnpm install
```

#### Database Connection Failed

```bash
# Check PostgreSQL is running
sudo systemctl status postgresql

# Test connection
psql -U agentkernel -d agentkernel -h localhost -c "SELECT 1"
```

#### Redis Connection Failed

```bash
# Check Redis is running
redis-cli ping

# Test with authentication
redis-cli -a your-redis-password ping
```

### Getting Help

- GitHub Issues: https://github.com/vijaygopalbalasa/AgentKernel/issues
- Documentation: See USAGE.md and POLICIES.md

## Next Steps

1. Read [USAGE.md](./USAGE.md) to learn CLI commands
2. Read [POLICIES.md](./POLICIES.md) to configure security policies
