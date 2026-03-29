# Deployment Guide

Complete guide for deploying the MCP Gateway to production on your VPS.

## Prerequisites

- Debian 12 VPS with SSH access
- Docker and Docker Compose installed
- Nginx Proxy Manager (NPM) running
- Domain configured with Cloudflare
- SSL certificate (Let's Encrypt via NPM)

## Deployment Steps

### 1. Prepare VPS

```bash
# SSH into VPS
ssh root@your-vps-ip

# Update system
apt update && apt upgrade -y

# Install Docker if not already installed
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# Install Docker Compose
apt install docker-compose -y

# Create deployment directory
mkdir -p /opt/mcp-gateway
cd /opt/mcp-gateway
```

### 2. Upload Code

Option A: Using Git
```bash
cd /opt/mcp-gateway
git clone https://your-repo/mcp-gateway.git .
```

Option B: Using SCP from local machine
```bash
# From your local machine
scp -r /root/PROJELER/AdvancedChatgptMcpServer/* root@your-vps:/opt/mcp-gateway/
```

### 3. Configure Environment

```bash
cd /opt/mcp-gateway

# Copy environment template
cp .env.example .env

# Edit configuration
nano .env
```

**Important Settings:**

```bash
# Production environment
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Generate secure agent keys
AGENT_KEYS_JSON='{"home-pc-1":"REPLACE_WITH_STRONG_KEY_1","home-pc-2":"REPLACE_WITH_STRONG_KEY_2"}'

# Optional: Internal bearer token for /sse endpoints
# Generate with: openssl rand -base64 32
INTERNAL_BEARER_TOKEN=REPLACE_WITH_STRONG_TOKEN

# Adjust timeouts if needed
AGENT_CALL_TIMEOUT_MS=30000
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5

# Enable metrics
ENABLE_METRICS=true
```

**Security Tips:**
- Use strong random keys: `openssl rand -base64 32`
- Never commit .env to version control
- Rotate keys periodically
- Use different keys for each agent

### 4. Build and Start

```bash
# Build the Docker image
docker-compose build

# Start the gateway
docker-compose up -d

# Verify it's running
docker-compose ps
docker-compose logs -f mcp-gateway

# Test health endpoint
curl http://localhost:3000/health_check
```

Expected output:
```json
{
  "status": "healthy",
  "version": "1.0.0",
  "uptime": 5,
  "gateway": {
    "connectedAgents": 0,
    "healthyAgents": 0,
    "totalTools": 0
  }
}
```

### 5. Configure Nginx Proxy Manager

Access your Nginx Proxy Manager UI (typically at http://your-vps:81).

#### Create Proxy Host

1. Navigate to **Hosts** → **Proxy Hosts** → **Add Proxy Host**

2. **Details Tab:**
   ```
   Domain Names: gateway.your-domain.com
   Scheme: http
   Forward Hostname/IP: mcp-gateway (or localhost if NPM is on same host)
   Forward Port: 3000
   
   ✓ Cache Assets
   ✓ Block Common Exploits
   ✓ Websockets Support
   ```

3. **SSL Tab:**
   ```
   ✓ Force SSL
   ✓ HTTP/2 Support
   ✓ HSTS Enabled
   ✓ HSTS Subdomains
   
   SSL Certificate: Request a new SSL Certificate (Let's Encrypt)
   Email: your-email@example.com
   ✓ I Agree to the Let's Encrypt Terms of Service
   ```

4. **Advanced Tab:**
   
   Add this configuration:
   
   ```nginx
   # Disable buffering for SSE
   proxy_buffering off;
   proxy_cache off;
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   
   # WebSocket support
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   
   # Standard headers
   proxy_set_header Host $host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
   proxy_set_header X-Forwarded-Proto $scheme;
   
   # Security headers
   add_header X-Content-Type-Options "nosniff" always;
   add_header X-Frame-Options "SAMEORIGIN" always;
   add_header X-XSS-Protection "1; mode=block" always;
   
   # CORS headers (if needed)
   add_header Access-Control-Allow-Origin "*" always;
   add_header Access-Control-Allow-Methods "GET, POST, OPTIONS" always;
   add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
   ```

5. Click **Save**

### 6. Configure Cloudflare

1. Log in to Cloudflare dashboard
2. Select your domain
3. Go to **DNS** → **Records**
4. Ensure A record points to your VPS IP:
   ```
   Type: A
   Name: chatgptmcp (or @ for root domain)
   IPv4 address: YOUR_VPS_IP
   Proxy status: Proxied (orange cloud)
   ```

5. Go to **SSL/TLS** → Set to **Full (strict)**

6. Go to **Network** → Enable **WebSockets**

7. (Optional) Go to **Security** → **WAF** → Configure rules:
   ```
   Rule: Block suspicious requests
   Expression: (cf.threat_score gt 30)
   Action: Challenge
   ```

8. (Optional) Setup **Cloudflare Access** for additional authentication

### 7. Verify Deployment

#### Test from Internet

```bash
# Test health check
curl https://gateway.your-domain.com/health_check

# Test SSE endpoint
curl -X POST https://gateway.your-domain.com/sse \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "test", "version": "1.0"}
    }
  }'

# Test SSE stream
curl -N -H "Accept: text/event-stream" \
  https://gateway.your-domain.com/sse
```

#### Test WebSocket Agent Connection

```bash
# Using wscat (install: npm install -g wscat)
wscat -c "wss://gateway.your-domain.com/agent/ws?token=YOUR_AGENT_KEY"

# Send register message
{"type":"register","protocolVersion":1,"agentId":"test","agentName":"Test","capabilities":{"tools":[]}}
```

### 8. Connect ChatGPT

1. Open ChatGPT
2. Go to Settings → Integrations → MCP Servers
3. Add new server:
   ```
   Name: My Gateway
   URL: https://gateway.your-domain.com/sse
   ```

4. If using `INTERNAL_BEARER_TOKEN`, configure:
   ```
   Headers:
   Authorization: Bearer YOUR_TOKEN_HERE
   ```

5. Save and test connection

### 9. Setup Monitoring

#### Enable Log Aggregation

```bash
# View live logs
docker-compose logs -f mcp-gateway

# Export logs to file
docker-compose logs mcp-gateway > /var/log/mcp-gateway.log
```

#### Setup Prometheus (Optional)

Create `prometheus.yml`:
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'mcp-gateway'
    static_configs:
      - targets: ['mcp-gateway:3000']
    metrics_path: '/metrics'
```

Add to docker-compose.yml:
```yaml
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    networks:
      - mcp-network

volumes:
  prometheus-data:
```

#### Setup Health Check Monitoring

Create a cron job for alerts:

```bash
# Create monitor script
cat > /opt/mcp-gateway/monitor.sh << 'EOF'
#!/bin/bash
HEALTH_URL="http://localhost:3000/health_check"
ALERT_EMAIL="your-email@example.com"

response=$(curl -s -o /dev/null -w "%{http_code}" $HEALTH_URL)

if [ "$response" != "200" ]; then
  echo "MCP Gateway health check failed: HTTP $response" | \
    mail -s "ALERT: MCP Gateway Down" $ALERT_EMAIL
fi
EOF

chmod +x /opt/mcp-gateway/monitor.sh

# Add to crontab (check every 5 minutes)
crontab -e
# Add line:
# */5 * * * * /opt/mcp-gateway/monitor.sh
```

### 10. Backup Strategy

```bash
# Create backup script
cat > /opt/mcp-gateway/backup.sh << 'EOF'
#!/bin/bash
BACKUP_DIR="/backups/mcp-gateway"
DATE=$(date +%Y%m%d_%H%M%S)

mkdir -p $BACKUP_DIR

# Backup configuration
tar -czf $BACKUP_DIR/config-$DATE.tar.gz \
  /opt/mcp-gateway/.env \
  /opt/mcp-gateway/docker-compose.yml

# Keep only last 7 days
find $BACKUP_DIR -name "*.tar.gz" -mtime +7 -delete

echo "Backup completed: config-$DATE.tar.gz"
EOF

chmod +x /opt/mcp-gateway/backup.sh

# Add to crontab (daily at 2 AM)
crontab -e
# Add line:
# 0 2 * * * /opt/mcp-gateway/backup.sh
```

### 11. Maintenance Tasks

#### Update Gateway

```bash
cd /opt/mcp-gateway

# Pull latest code
git pull

# Rebuild and restart
docker-compose down
docker-compose build
docker-compose up -d

# Verify
docker-compose logs -f mcp-gateway
curl https://gateway.your-domain.com/health_check
```

#### View Logs

```bash
# Real-time logs
docker-compose logs -f mcp-gateway

# Last 100 lines
docker-compose logs --tail=100 mcp-gateway

# Logs from specific time
docker-compose logs --since="2026-01-14T10:00:00" mcp-gateway
```

#### Restart Gateway

```bash
docker-compose restart mcp-gateway
```

#### Clean Up

```bash
# Remove unused Docker images
docker image prune -a

# Remove unused volumes
docker volume prune
```

### 12. Security Hardening

#### Firewall Rules

```bash
# Allow only necessary ports
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp    # SSH
ufw allow 80/tcp    # HTTP (for Let's Encrypt)
ufw allow 443/tcp   # HTTPS
ufw enable
```

#### Fail2ban for SSH

```bash
apt install fail2ban -y
systemctl enable fail2ban
systemctl start fail2ban
```

#### Regular Updates

```bash
# Create update script
cat > /opt/mcp-gateway/update.sh << 'EOF'
#!/bin/bash
apt update
apt upgrade -y
apt autoremove -y
docker system prune -f
EOF

chmod +x /opt/mcp-gateway/update.sh

# Add to crontab (weekly on Sunday at 3 AM)
crontab -e
# Add line:
# 0 3 * * 0 /opt/mcp-gateway/update.sh
```

## Troubleshooting

### Gateway Won't Start

```bash
# Check logs
docker-compose logs mcp-gateway

# Check container status
docker-compose ps

# Rebuild from scratch
docker-compose down -v
docker-compose build --no-cache
docker-compose up -d
```

### SSL Certificate Issues

```bash
# Check NPM logs
docker logs nginx-proxy-manager

# Manually renew certificate in NPM UI
# Or use certbot directly
```

### Agents Can't Connect

```bash
# Check WebSocket is accessible
wscat -c "wss://gateway.your-domain.com/agent/ws?token=test"

# Check Cloudflare WebSocket is enabled
# Check NPM has websocket support enabled

# Test direct connection (bypass Cloudflare)
wscat -c "ws://YOUR_VPS_IP:3000/agent/ws?token=test"
```

### Performance Issues

```bash
# Check resource usage
docker stats mcp-gateway

# Increase resources in docker-compose.yml
services:
  mcp-gateway:
    deploy:
      resources:
        limits:
          cpus: '2'
          memory: 2G
```

## Rollback Procedure

If deployment fails:

```bash
# Stop new version
docker-compose down

# Restore configuration backup
cd /backups/mcp-gateway
tar -xzf config-YYYYMMDD_HHMMSS.tar.gz -C /

# Start previous version
cd /opt/mcp-gateway
git checkout <previous-commit>
docker-compose up -d
```

## Production Checklist

- [ ] Environment variables configured with strong keys
- [ ] .env file protected (not in git, proper permissions)
- [ ] Docker container running and healthy
- [ ] Nginx Proxy Manager configured correctly
- [ ] SSL certificate valid
- [ ] Cloudflare proxy enabled
- [ ] WebSocket connections working
- [ ] Health check endpoint accessible
- [ ] Monitoring configured
- [ ] Backup script scheduled
- [ ] Firewall rules configured
- [ ] ChatGPT connector tested
- [ ] Agent connections tested
- [ ] Documentation updated with production URLs

---

Your MCP Gateway should now be fully deployed and production-ready!
