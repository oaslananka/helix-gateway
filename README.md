# helix-gateway

> Production-grade MCP Gateway that aggregates tools from remote agents over WebSocket.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/oaslananka/helix-gateway/pkgs/container/helix-gateway)

## What is this?

Helix Gateway runs on a VPS and acts as a stable, secure bridge between AI clients
(ChatGPT, Claude) and remote agents running on your local machines. Built on the
Model Context Protocol (MCP), it aggregates tools from multiple agents and exposes
them through a single authenticated endpoint.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Public Internet                             │
│                    (Cloudflare + WAF)                            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ HTTPS
                         │
┌────────────────────────▼────────────────────────────────────────┐
│              Nginx Proxy Manager (VPS)                          │
│          https://gateway.your-domain.com                        │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ HTTP/WS
                         │
┌────────────────────────▼────────────────────────────────────────┐
│                    MCP Gateway (This)                           │
│                                                                  │
│  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐│
│  │  MCP SSE Server  │  │  Tool Router     │  │ Agent Registry││
│  │  /sse (GET/POST) │  │  Route & Cache   │  │ + Circuit     ││
│  └──────────────────┘  └──────────────────┘  │   Breaker     ││
│                                               └───────────────┘│
│                          ▲                                       │
```

## Quick Start

```bash
cp .env.example .env
# Edit .env: set AGENT_KEYS and PUBLIC_URL

docker-compose up -d
docker-compose logs -f gateway
```

## Observability

OpenTelemetry tracing + Grafana Tempo included:

```bash
# Start with full observability stack
docker-compose up -d

# Open Grafana
open http://localhost:3001
```

Set `OTEL_ENABLED=true` in `.env` to enable tracing.

## A2A Compatibility

This gateway exposes an A2A-compatible agent card at `/.well-known/agent.json`,
making it discoverable by other A2A-protocol agents.

## Security

- Per-agent API key authentication
- Bearer token for MCP SSE endpoints
- Rate limiting (configurable)
- Circuit breaker per agent
- Cloudflare-compatible headers

## Ecosystem

This gateway works with [helix-agent](https://github.com/oaslananka/helix-agent).

## Contributing

Built with AI assistance (Claude). Architecture, security design and deployment
configuration by the maintainer.

CI for this repository runs on Azure Pipelines. Archived GitHub Actions workflows are
kept only for reference and are not part of the active delivery path.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

<!-- CI AUTO TEST 2026-03-29T10:40:30+03:00 -->
