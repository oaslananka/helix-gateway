// MUST be first import — load env before any module snapshots process.env
import 'dotenv/config';
import { initTracing } from './observability/tracing.js';

initTracing({
  serviceName: 'helix-gateway',
  serviceVersion: process.env.npm_package_version ?? '1.0.0',
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  enabled: process.env.OTEL_ENABLED !== 'false',
});

import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import cors from 'cors';
import { buildAgentCard } from './a2a/agentCard.js';
import pinoHttp from 'pino-http';
import { logger } from './observability/logger.js';
import { metrics } from './observability/metrics.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { authMiddleware } from './middleware/auth.js';
import { apiRateLimiter } from './middleware/rateLimit.js';
import { mcpServer } from './mcp/mcpServer.js';
import { agentWsServer } from './agent/agentWsServer.js';
import { agentHttpPoller } from './agent/agentHttpPoller.js';
import { agentRegistry } from './agent/agentRegistry.js';
import { createAdminRouter, adminAuthMiddleware } from './admin/adminRoutes.js';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create Express app
const app = express();

// Create HTTP server
const httpServer = createServer(app);

// Create WebSocket server for agents
const wss = new WebSocketServer({
  server: httpServer,
  path: '/agent/ws',
});

// Global error handlers
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal({ reason, promise }, 'Unhandled rejection');
  process.exit(1);
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(requestIdMiddleware);

// HTTP request logging
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health_check' || req.url === '/metrics',
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res, error) => {
    return `${req.method} ${req.url} ${res.statusCode} - ${error.message}`;
  },
}));

// Rate limiting
app.use(apiRateLimiter);

// Metrics tracking
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    metrics.httpRequestDuration.observe(
      { method: req.method, path: req.path, status: String(res.statusCode) },
      duration
    );
    metrics.httpRequestsTotal.inc({
      method: req.method,
      path: req.path,
      status: String(res.statusCode),
    });
  });

  next();
});

// Routes


// A2A Protocol — Agent discovery endpoint
app.get('/.well-known/agent.json', (_req: Request, res: Response) => {
  const allAgents = agentRegistry.getAllAgents();

  const skills: Array<{ id: string; name: string; description: string; tags: string[] }> = [];

  for (const agent of allAgents) {
    const agentTools = agentRegistry.getAgentTools(agent.agentId);
    for (const tool of agentTools) {
      skills.push({
        id: tool.name,
        name: tool.name,
        description: tool.description || '',
        tags: [agent.agentId],
      });
    }
  }

  const card = buildAgentCard({
    name: 'Helix Gateway',
    description: 'MCP Gateway that aggregates tools from remote agents over WebSocket',
    version: process.env.npm_package_version ?? '1.0.0',
    publicUrl: process.env.PUBLIC_URL ?? 'http://localhost:3000',
    skills,
  });

  res.json(card);
});

// Root endpoint
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'MCP Gateway',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      sse: '/sse (GET for stream, POST for JSON-RPC)',
      agentWs: '/agent/ws (WebSocket for agents)',
      health: '/health_check',
      metrics: '/metrics',
    },
  });
});

// Health check endpoint
app.get('/health_check', (_req: Request, res: Response) => {
  const stats = agentRegistry.getStats();
  const uptime = process.uptime();

  res.json({
    status: 'healthy',
    version: '1.0.0',
    uptime: Math.floor(uptime),
    timestamp: new Date().toISOString(),
    gateway: {
      connectedAgents: stats.connectedAgents,
      healthyAgents: stats.healthyAgents,
      totalTools: stats.totalTools,
    },
    agents: stats.agents,
  });
});

// Metrics endpoint
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metricsData = await metrics.getMetrics();
    res.set('Content-Type', 'text/plain');
    res.send(metricsData);
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).send('Error generating metrics');
  }
});

// MCP SSE endpoints
app.get('/sse', (req: Request, res: Response) => {
  mcpServer.handleSSEGet(req, res);
});

app.post('/sse', authMiddleware, async (req: Request, res: Response) => {
  await mcpServer.handleSSEPost(req, res);
});

// Handle OPTIONS for CORS preflight
app.options('/sse', cors());

// Admin API routes
app.use('/admin', adminAuthMiddleware, createAdminRouter());

// Serve admin panel static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/admin-ui', express.static(path.join(__dirname, '../public/admin')));

// Redirect /admin-ui to /admin-ui/index.html
app.get('/admin-ui', (_req: Request, res: Response) => {
  res.redirect('/admin-ui/index.html');
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: Request, res: Response, _next: unknown) => {
  logger.error({ error: err, requestId: req.id }, 'Express error handler');
  res.status(500).json({ error: 'Internal server error' });
});

// Initialize agent WebSocket server
agentWsServer.init(wss);

// Initialize HTTP polling mode (if configured)
agentHttpPoller.init();

// Graceful shutdown
const shutdown = async () => {
  logger.info('Shutting down gracefully...');

  // Stop accepting new connections
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });

  // Shutdown agent WebSocket server
  agentWsServer.shutdown();

  // Shutdown HTTP poller
  agentHttpPoller.shutdown();

  // Give some time for cleanup
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 1000);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
httpServer.listen(PORT, () => {
  logger.info({
    port: PORT,
    env: NODE_ENV,
    pid: process.pid,
  }, 'MCP Gateway started');

  console.log(`
╔═══════════════════════════════════════════╗
║       MCP Gateway Started                 ║
╠═══════════════════════════════════════════╣
║  Port:        ${PORT}                        ║
║  Environment: ${NODE_ENV.padEnd(10)}           ║
║  Health:      http://localhost:${PORT}/health_check
║  Metrics:     http://localhost:${PORT}/metrics
║  SSE:         http://localhost:${PORT}/sse
║  Agent WS:    ws://localhost:${PORT}/agent/ws
╚═══════════════════════════════════════════╝
  `);
});

export { app, httpServer, wss };
