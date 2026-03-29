import { ValidationError } from '../errors/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../observability/logger.js';
import { validateAgentAuth } from '../middleware/auth.js';
import { agentRegistry } from './agentRegistry.js';
import {
  validateAgentMessage,
  isCallResult,
  isPing,
  isCapabilitiesUpdate,
  AgentPongMessage,
  AgentCallResult,
  AGENT_PROTOCOL_VERSION,
} from './agentProtocol.js';

const AGENT_KEEPALIVE_INTERVAL_MS = parseInt(
  process.env.AGENT_KEEPALIVE_INTERVAL_MS || '15000',
  10
);
const DUPLICATE_AGENT_STRATEGY = process.env.DUPLICATE_AGENT_STRATEGY || 'kick_old';

export class AgentWsServer {
  private wss: WebSocketServer | null = null;
  private keepaliveIntervals: Map<string, NodeJS.Timeout> = new Map();

  init(wss: WebSocketServer): void {
    this.wss = wss;

    wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    logger.info('Agent WebSocket server initialized');
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || undefined;
    const agentIdParam = url.searchParams.get('agentId') || undefined;
    const agentKeyHeader = req.headers['x-agent-key'] as string | undefined;
    const ip = req.socket.remoteAddress;

    logger.info({ ip, url: req.url }, 'Agent connection attempt');

    let agentId: string | null = null;
    let authenticated = false;

    // Handle authentication and registration
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        
        // Handle registration
        if (message.type === 'register' && !authenticated) {
          const messageAgentId = message.agentId as string;
          agentId = messageAgentId;
          
          // Support agentId from query param if provided
          if (agentIdParam && agentIdParam !== agentId) {
            logger.warn({ agentIdParam, messageAgentId: agentId }, 'AgentId mismatch');
            ws.send(JSON.stringify({
              type: 'error',
              error: 'AgentId mismatch between query and message',
            }));
            ws.close();
            return;
          }
          
          // Validate protocol version
          if (message.protocolVersion !== AGENT_PROTOCOL_VERSION) {
            logger.warn({
              agentId,
              version: message.protocolVersion,
              expected: AGENT_PROTOCOL_VERSION,
            }, 'Incompatible protocol version');
            
            ws.send(JSON.stringify({
              type: 'error',
              error: `Incompatible protocol version. Expected ${AGENT_PROTOCOL_VERSION}, got ${message.protocolVersion}`,
            }));
            ws.close();
            return;
          }

          // Authenticate
          const providedKey = token || agentKeyHeader || '';
          
          if (!validateAgentAuth(messageAgentId, providedKey)) {
            logger.warn({ agentId: messageAgentId, ip }, 'Agent authentication failed');
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Authentication failed',
            }));
            ws.close();
            return;
          }

          authenticated = true;

          // Handle duplicate connections
          const existing = agentRegistry.getAgent(messageAgentId);
          
          if (existing) {
            if (DUPLICATE_AGENT_STRATEGY === 'kick_old') {
              logger.info({ agentId: messageAgentId }, 'Kicking old agent connection');
              agentRegistry.unregisterAgent(messageAgentId, 'duplicate_connection');
            } else {
              logger.warn({ agentId: messageAgentId }, 'Rejecting new connection (duplicate)');
              ws.send(JSON.stringify({
                type: 'error',
                error: 'Agent already connected',
              }));
              ws.close();
              return;
            }
          }

          // Validate registration message
          const validatedMessage = validateAgentMessage(message);
          
          if (validatedMessage.type !== 'register') {
            throw new ValidationError('Invalid register message');
          }

          // Register agent
          agentRegistry.registerAgent(
            messageAgentId,
            validatedMessage.agentName,
            ws,
            validatedMessage.capabilities,
            validatedMessage.meta
          );

          // Send success response
          ws.send(JSON.stringify({
            type: 'registered',
            protocolVersion: AGENT_PROTOCOL_VERSION,
            gatewayVersion: '1.0.0',
          }));

          // Start keepalive
          this.startKeepalive(messageAgentId, ws);

          logger.info({
            agentId: messageAgentId,
            agentName: validatedMessage.agentName,
            toolCount: validatedMessage.capabilities.tools.length,
          }, 'Agent registered successfully');
          
          return;
        }

        // All other messages require authentication
        if (!authenticated || !agentId) {
          logger.warn({ ip }, 'Unauthenticated message attempt');
          ws.close();
          return;
        }

        // Validate message
        const validatedMessage = validateAgentMessage(message);

        // Handle different message types
        if (isPing(validatedMessage)) {
          this.handlePing(agentId, ws, validatedMessage);
        } else if (isCallResult(validatedMessage)) {
          this.handleCallResult(agentId, validatedMessage);
        } else if (isCapabilitiesUpdate(validatedMessage)) {
          this.handleCapabilitiesUpdate(agentId, validatedMessage);
        } else {
          logger.warn({ agentId, type: message.type }, 'Unknown message type');
        }

        // Update last seen
        agentRegistry.updateLastSeen(agentId);
        
      } catch (error) {
        logger.error({ error, agentId }, 'Error processing agent message');
        
        if (error instanceof Error) {
          ws.send(JSON.stringify({
            type: 'error',
            error: error.message,
          }));
        }
      }
    });

    ws.on('close', () => {
      if (agentId) {
        logger.info({ agentId }, 'Agent disconnected');
        this.stopKeepalive(agentId);
        agentRegistry.unregisterAgent(agentId, 'connection_closed');
      }
    });

    ws.on('error', (error) => {
      logger.error({ error, agentId }, 'Agent WebSocket error');
    });
  }

  private handlePing(_agentId: string, ws: WebSocket, message: { type: 'ping'; ts: number }): void {
    const pong: AgentPongMessage = {
      type: 'pong',
      ts: message.ts,
    };
    
    ws.send(JSON.stringify(pong));
  }

  private handleCallResult(
    agentId: string,
    message: { type: 'call_result'; requestId: string; ok: boolean; result?: unknown; error?: unknown }
  ): void {
    agentRegistry.handleCallResult(agentId, message as AgentCallResult);
  }

  private handleCapabilitiesUpdate(
    agentId: string,
    message: { type: 'capabilities_update'; protocolVersion: number; capabilities: { tools: Array<{
      name: string;
      description: string;
      inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
    }>; resources?: unknown[]; prompts?: unknown[] } }
  ): void {
    agentRegistry.updateCapabilities(agentId, {
      tools: message.capabilities.tools,
      resources: message.capabilities.resources || [],
      prompts: message.capabilities.prompts || [],
    });
  }

  private startKeepalive(agentId: string, ws: WebSocket): void {
    const interval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } else {
        this.stopKeepalive(agentId);
      }
    }, AGENT_KEEPALIVE_INTERVAL_MS);
    interval.unref();

    this.keepaliveIntervals.set(agentId, interval);
  }

  private stopKeepalive(agentId: string): void {
    const interval = this.keepaliveIntervals.get(agentId);
    
    if (interval) {
      clearInterval(interval);
      this.keepaliveIntervals.delete(agentId);
    }
  }

  shutdown(): void {
    // Clear all keepalive intervals
    for (const interval of this.keepaliveIntervals.values()) {
      clearInterval(interval);
    }
    this.keepaliveIntervals.clear();

    // Close all agent connections
    for (const agentId of agentRegistry.getConnectedAgentIds()) {
      agentRegistry.unregisterAgent(agentId, 'server_shutdown');
    }

    // Close WebSocket server
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    logger.info('Agent WebSocket server shut down');
  }
}

export const agentWsServer = new AgentWsServer();
