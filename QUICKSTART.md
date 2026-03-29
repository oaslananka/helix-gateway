# MCP Gateway - Quick Start Guide

## What is This?

A production-grade gateway that allows ChatGPT to use tools from multiple agents (your home computers, servers, etc.) without modifying the gateway itself. The gateway stays stable on your VPS while you can add/remove tools dynamically by connecting/disconnecting agents.

## 5-Minute Setup

### 1. Install Dependencies

```bash
cd helix-gateway
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

Set at minimum:
```bash
AGENT_KEYS_JSON='{"home-pc-1":"your-secret-key-here"}'
```

### 3. Start Gateway

```bash
# Development
npm run dev

# Production (Docker)
docker-compose up -d
```

### 4. Verify It Works

```bash
chmod +x verify.sh
./verify.sh
```

### 5. Connect an Agent

See [AGENT_EXAMPLE.md](AGENT_EXAMPLE.md) for full agent implementations.

Quick test agent (Node.js):
```javascript
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/agent/ws?token=your-secret-key-here');

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'register',
    protocolVersion: 1,
    agentId: 'home-pc-1',
    agentName: 'My Home PC',
    capabilities: {
      tools: [{
        name: 'test.echo',
        description: 'Echo test',
        inputSchema: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message']
        }
      }]
    }
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  console.log('Received:', msg.type);
  
  if (msg.type === 'ping') {
    ws.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
  }
  
  if (msg.type === 'call') {
    ws.send(JSON.stringify({
      type: 'call_result',
      requestId: msg.requestId,
      ok: true,
      result: {
        content: [{ type: 'text', text: `Echo: ${msg.arguments?.message}` }]
      }
    }));
  }
});
```

Save as `test-agent.js` and run:
```bash
node test-agent.js
```

### 6. Connect ChatGPT

1. Open ChatGPT Settings → Integrations → MCP Servers
2. Add server:
   - URL: `https://gateway.your-domain.com/sse`
   - (or `http://localhost:3000/sse` for local testing)

## Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/sse` | GET | SSE stream for ChatGPT |
| `/sse` | POST | JSON-RPC requests |
| `/agent/ws` | WebSocket | Agent connections |
| `/health_check` | GET | Health status |
| `/metrics` | GET | Prometheus metrics |

## Common Commands

```bash
# View logs
docker-compose logs -f mcp-gateway

# Restart gateway
docker-compose restart mcp-gateway

# Check health
curl http://localhost:3000/health_check

# List tools
curl -X POST http://localhost:3000/sse \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# Test agent connection
wscat -c "ws://localhost:3000/agent/ws?token=your-secret-key-here"
```

## Architecture in 3 Sentences

1. **Gateway** runs on VPS, exposes stable `/sse` endpoint to ChatGPT
2. **Agents** connect from anywhere via WebSocket, register their tools
3. **Gateway** routes tool calls from ChatGPT to the correct agent

## Project Structure

```
src/
├── agent/          # Agent WebSocket server & registry
├── mcp/            # MCP protocol handlers
├── middleware/     # Auth, rate limiting, request ID
├── observability/  # Logging & metrics
├── routing/        # Tool routing logic
└── index.ts        # Main application

test/               # Integration tests
AGENT_EXAMPLE.md    # How to build an agent
DEPLOYMENT.md       # Production deployment guide
README.md           # Full documentation
```

## Troubleshooting

**Gateway won't start:**
```bash
docker-compose logs mcp-gateway
# Check for port conflicts, config errors
```

**Agent can't connect:**
```bash
# Verify key in AGENT_KEYS_JSON matches
# Check WebSocket is accessible
wscat -c "ws://localhost:3000/agent/ws?token=test"
```

**Tools not appearing:**
```bash
# Check agent is connected
curl http://localhost:3000/health_check | jq '.agents'

# Check circuit breaker state (should be "closed")
curl http://localhost:3000/health_check | jq '.agents[].state'
```

**ChatGPT can't connect:**
```bash
# Test SSE endpoint
curl -X POST http://localhost:3000/sse \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

## Next Steps

1. ✅ Verify gateway is running: `./verify.sh`
2. 📝 Read [AGENT_EXAMPLE.md](AGENT_EXAMPLE.md) to build your first agent
3. 🚀 Deploy to production: [DEPLOYMENT.md](DEPLOYMENT.md)
4. 📖 Full documentation: [README.md](README.md)

## Security Checklist

- [ ] Strong random keys in `AGENT_KEYS_JSON`
- [ ] `.env` file not in git (already in .gitignore)
- [ ] Optional `INTERNAL_BEARER_TOKEN` set for /sse
- [ ] Cloudflare proxy enabled
- [ ] SSL certificate configured
- [ ] Rate limiting enabled (default: on)
- [ ] Firewall rules configured on VPS

## Performance Tips

- Default timeouts are conservative (30s)
- Circuit breaker protects against failing agents
- Tool cache reduces latency (60s TTL)
- Metrics help identify bottlenecks

## Support

- Issues: Open GitHub issue
- Logs: `docker-compose logs -f mcp-gateway`
- Metrics: `http://localhost:3000/metrics`
- Health: `http://localhost:3000/health_check`

---

**Built for production. Battle-tested. Ready to scale.** 🚀
