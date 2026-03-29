import { Router, Request, Response, NextFunction } from 'express';
import { agentRegistry } from '../agent/agentRegistry.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

function getAdminToken(): string | undefined {
    return process.env.ADMIN_API_TOKEN || process.env.INTERNAL_BEARER_TOKEN;
}

// Admin authentication middleware
export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
    const adminToken = getAdminToken();

    // Skip auth if no token is configured (development mode)
    if (!adminToken) {
        logger.warn('Admin API running without authentication! Set ADMIN_API_TOKEN');
        return next();
    }

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' });
        return;
    }

    const token = authHeader.substring(7);

    if (token !== adminToken) {
        res.status(403).json({ error: 'Invalid token' });
        return;
    }

    next();
}

// Create admin router
export function createAdminRouter(): Router {
    const router = Router();

    // Dashboard stats
    router.get('/dashboard', (_req: Request, res: Response) => {
        try {
            const stats = agentRegistry.getStats();
            const promMetrics = metrics.getMetricsSummary();

            res.json({
                timestamp: new Date().toISOString(),
                uptime: process.uptime(),
                gateway: {
                    version: process.env.npm_package_version || '1.0.0',
                    nodeVersion: process.version,
                },
                agents: stats,
                metrics: promMetrics,
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'Dashboard stats error');
            res.status(500).json({ error: 'Failed to get dashboard stats' });
        }
    });

    // List all agents
    router.get('/agents', (_req: Request, res: Response) => {
        try {
            const agents = agentRegistry.getAllAgents();

            res.json({
                count: agents.length,
                agents: agents.map(a => ({
                    id: a.agentId,
                    name: a.agentName,
                    status: a.circuitBreaker.state === 'open' ? 'unhealthy' : 'healthy',
                    circuitBreaker: a.circuitBreaker.state,
                    toolCount: a.capabilities.tools.length,
                    tools: a.capabilities.tools.map(t => t.name),
                    meta: a.meta,
                    registeredAt: new Date(a.registeredAt).toISOString(),
                    lastSeen: new Date(a.lastSeen).toISOString(),
                    uptime: Date.now() - a.registeredAt,
                    pendingCalls: a.pendingCalls.size,
                })),
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'List agents error');
            res.status(500).json({ error: 'Failed to list agents' });
        }
    });

    // Get specific agent
    router.get('/agents/:agentId', (req: Request, res: Response) => {
        try {
            const { agentId } = req.params;
            const agent = agentRegistry.getAgent(agentId);

            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }

            res.json({
                id: agent.agentId,
                name: agent.agentName,
                status: agent.circuitBreaker.state === 'open' ? 'unhealthy' : 'healthy',
                circuitBreaker: {
                    state: agent.circuitBreaker.state,
                    failureCount: agent.circuitBreaker.failureCount,
                    lastFailure: agent.circuitBreaker.lastFailure
                        ? new Date(agent.circuitBreaker.lastFailure).toISOString()
                        : null,
                },
                tools: agent.capabilities.tools,
                meta: agent.meta,
                registeredAt: new Date(agent.registeredAt).toISOString(),
                lastSeen: new Date(agent.lastSeen).toISOString(),
                uptime: Date.now() - agent.registeredAt,
                pendingCalls: agent.pendingCalls.size,
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'Get agent error');
            res.status(500).json({ error: 'Failed to get agent' });
        }
    });

    // Disconnect an agent
    router.post('/agents/:agentId/disconnect', (req: Request, res: Response) => {
        try {
            const { agentId } = req.params;
            const agent = agentRegistry.getAgent(agentId);

            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }

            agentRegistry.unregisterAgent(agentId, 'admin_disconnect');

            logger.info({ agentId }, 'Agent disconnected by admin');

            res.json({ success: true, message: `Agent ${agentId} disconnected` });
        } catch (error) {
            logger.error({ error: String(error) }, 'Disconnect agent error');
            res.status(500).json({ error: 'Failed to disconnect agent' });
        }
    });

    // Reset circuit breaker for an agent
    router.post('/agents/:agentId/reset-circuit-breaker', (req: Request, res: Response) => {
        try {
            const { agentId } = req.params;
            const agent = agentRegistry.getAgent(agentId);

            if (!agent) {
                res.status(404).json({ error: 'Agent not found' });
                return;
            }

            // Reset circuit breaker
            agent.circuitBreaker.state = 'closed';
            agent.circuitBreaker.failureCount = 0;
            agent.circuitBreaker.lastFailure = 0;

            logger.info({ agentId }, 'Circuit breaker reset by admin');

            res.json({
                success: true,
                message: `Circuit breaker for ${agentId} reset`,
                circuitBreaker: agent.circuitBreaker,
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'Reset circuit breaker error');
            res.status(500).json({ error: 'Failed to reset circuit breaker' });
        }
    });

    // List all tools
    router.get('/tools', (_req: Request, res: Response) => {
        try {
            const allTools = agentRegistry.getAllTools();

            res.json({
                count: allTools.length,
                tools: allTools.map(t => ({
                    name: t.name,
                    description: t.description.substring(0, 200) + (t.description.length > 200 ? '...' : ''),
                    agent: agentRegistry.findToolAgent(t.name),
                })),
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'List tools error');
            res.status(500).json({ error: 'Failed to list tools' });
        }
    });

    // Get specific tool
    router.get('/tools/:toolName', (req: Request, res: Response) => {
        try {
            const { toolName } = req.params;
            const agentId = agentRegistry.findToolAgent(toolName);

            if (!agentId) {
                res.status(404).json({ error: 'Tool not found' });
                return;
            }

            const agent = agentRegistry.getAgent(agentId);
            const tool = agent?.capabilities.tools.find(t =>
                t.name === toolName || `${agentId}.${t.name}` === toolName
            );

            if (!tool) {
                res.status(404).json({ error: 'Tool not found' });
                return;
            }

            res.json({
                name: tool.name,
                agent: agentId,
                description: tool.description,
                inputSchema: tool.inputSchema,
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'Get tool error');
            res.status(500).json({ error: 'Failed to get tool' });
        }
    });

    // Gateway logs (last N lines from memory buffer)
    router.get('/logs', (req: Request, res: Response) => {
        try {
            const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
            const level = req.query.level as string;

            // Get logs from logger buffer if available
            const logs = logger.getRecentLogs ? logger.getRecentLogs(limit, level) : [];

            res.json({
                count: logs.length,
                logs,
            });
        } catch (error) {
            logger.error({ error: String(error) }, 'Get logs error');
            res.status(500).json({ error: 'Failed to get logs' });
        }
    });

    // Health overview
    router.get('/health', (_req: Request, res: Response) => {
        try {
            const stats = agentRegistry.getStats();
            const isHealthy = stats.connectedAgents > 0 && stats.healthyAgents > 0;

            res.status(isHealthy ? 200 : 503).json({
                status: isHealthy ? 'healthy' : 'degraded',
                timestamp: new Date().toISOString(),
                agents: {
                    connected: stats.connectedAgents,
                    healthy: stats.healthyAgents,
                },
                tools: stats.totalTools,
            });
        } catch (error) {
            res.status(500).json({ status: 'error', error: String(error) });
        }
    });

    return router;
}
