# Contributing to helix-gateway

## Development Setup

```bash
git clone https://github.com/oaslananka/helix-gateway
cd helix-gateway
cp .env.example .env
npm install
npm run dev
```

## Running Tests

```bash
npm test
npm test -- --watch
```

## Architecture

- `src/agent/` — WebSocket server for agent connections
- `src/mcp/` — MCP SSE server for AI client connections
- `src/routing/` — Tool routing from AI clients to agents
- `src/observability/` — Logging, metrics, tracing
- `src/a2a/` — A2A protocol compatibility

## Code Standards

- TypeScript strict mode
- Zod for all runtime validation
- Typed errors only (`HelixError` subclasses)
- OpenTelemetry spans for all async operations

## Pull Request Process

1. Fork and create a feature branch
2. Write tests for new functionality
3. Ensure CI passes
4. Open a PR with description
