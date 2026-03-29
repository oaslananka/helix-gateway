import { Request, Response } from 'express';
import { logger } from '../observability/logger.js';
import { toolRouter } from '../routing/toolRouter.js';
import {
  MCPRequest,
  MCPResponse,
  MCPInitializeParams,
  MCPInitializeResult,
  MCPToolsListResult,
  MCPToolCallParams,
} from './mcpTypes.js';
import {
  MCPErrorClass,
  createParseError,
  createInvalidRequest,
  createMethodNotFound,
  createInvalidParams,
  createInternalError,
} from './mcpErrors.js';

const SSE_KEEPALIVE_INTERVAL_MS = parseInt(
  process.env.SSE_KEEPALIVE_INTERVAL_MS || '15000',
  10
);
const SSE_KEEPALIVE_COMMENT = process.env.SSE_KEEPALIVE_COMMENT || ':keepalive';

export class MCPServer {
  /**
   * Handle SSE GET endpoint - establishes event stream
   */
  handleSSEGet(req: Request, res: Response): void {
    logger.info({ requestId: req.id, ip: req.ip }, 'SSE connection established');

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

    // Send initial comment
    res.write(': MCP Gateway SSE Stream\n\n');

    // Setup keepalive
    const keepaliveInterval = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`${SSE_KEEPALIVE_COMMENT}\n\n`);
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(keepaliveInterval);
      logger.info({ requestId: req.id }, 'SSE connection closed');
    });

    res.on('error', (error) => {
      clearInterval(keepaliveInterval);
      logger.error({ requestId: req.id, error }, 'SSE connection error');
    });
  }

  /**
   * Handle SSE POST endpoint - JSON-RPC requests
   */
  async handleSSEPost(req: Request, res: Response): Promise<void> {
    try {
      const mcpRequest = this.parseRequest(req.body);
      
      logger.info({
        requestId: req.id,
        method: mcpRequest.method,
        id: mcpRequest.id,
      }, 'MCP request received');

      const response = await this.handleRequest(mcpRequest, String(req.id));
      
      res.json(response);
      
    } catch (error) {
      if (error instanceof MCPErrorClass) {
        const response: MCPResponse = {
          jsonrpc: '2.0',
          id: null as any,
          error: error.toJSON(),
        };
        res.json(response);
      } else {
        logger.error({ requestId: req.id, error }, 'Unexpected error in MCP handler');
        const response: MCPResponse = {
          jsonrpc: '2.0',
          id: null as any,
          error: createInternalError('Internal server error').toJSON(),
        };
        res.status(500).json(response);
      }
    }
  }

  /**
   * Parse and validate incoming MCP request
   */
  private parseRequest(body: unknown): MCPRequest {
    if (!body || typeof body !== 'object') {
      throw createParseError('Invalid JSON-RPC request');
    }

    const req = body as Partial<MCPRequest>;

    if (req.jsonrpc !== '2.0') {
      throw createInvalidRequest('Invalid jsonrpc version');
    }

    if (!req.method || typeof req.method !== 'string') {
      throw createInvalidRequest('Missing or invalid method');
    }

    return req as MCPRequest;
  }

  /**
   * Route request to appropriate handler
   */
  private async handleRequest(req: MCPRequest, requestId: string): Promise<MCPResponse> {
    try {
      switch (req.method) {
        case 'initialize':
          return this.handleInitialize(req);
        
        case 'notifications/initialized':
          return this.handleNotificationInitialized(req);
        
        case 'tools/list':
          return await this.handleToolsList(req);
        
        case 'tools/call':
          return await this.handleToolsCall(req, requestId);
        
        default:
          throw createMethodNotFound(req.method);
      }
    } catch (error) {
      if (error instanceof MCPErrorClass) {
        return {
          jsonrpc: '2.0',
          id: req.id || null as any,
          error: error.toJSON(),
        };
      }
      
      logger.error({ requestId, error }, 'Error handling MCP request');
      
      return {
        jsonrpc: '2.0',
        id: req.id || null as any,
        error: createInternalError(
          error instanceof Error ? error.message : 'Unknown error'
        ).toJSON(),
      };
    }
  }

  /**
   * Handle initialize request
   */
  private handleInitialize(req: MCPRequest): MCPResponse {
    const params = req.params as Partial<MCPInitializeParams> | undefined;

    if (!params?.protocolVersion) {
      throw createInvalidParams('Missing protocolVersion');
    }

    const result: MCPInitializeResult = {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: { listChanged: true },
        logging: {},
      },
      serverInfo: {
        name: 'MCP Gateway',
        version: '1.0.0',
      },
    };

    return {
      jsonrpc: '2.0',
      id: req.id!,
      result,
    };
  }

  /**
   * Handle notifications/initialized notification
   */
  private handleNotificationInitialized(req: MCPRequest): MCPResponse {
    // Notification - no response needed, but we return one for compatibility
    logger.debug({ id: req.id }, 'Received initialized notification');
    
    // Return empty success for compatibility
    return {
      jsonrpc: '2.0',
      id: req.id || 0,
      result: {},
    };
  }

  /**
   * Handle tools/list request
    logger.info({ cached: true }, '📋 Tools list requested');
   */
  private async handleToolsList(req: MCPRequest): Promise<MCPResponse> {
    // Notify all agents about tools/list request
    const { agentRegistry } = await import("../agent/agentRegistry.js");
    for (const agent of agentRegistry.getAllAgents()) {
      logger.debug({ agentId: agent.agentId }, "Tools list requested from agent");
    }
    const tools = await toolRouter.listTools();

    const result: MCPToolsListResult = {
      tools,
    };

    return {
      jsonrpc: '2.0',
      id: req.id!,
      result,
    };
  }

  /**
   * Handle tools/call request
   */
  private async handleToolsCall(req: MCPRequest, requestId: string): Promise<MCPResponse> {
    const params = req.params as Partial<MCPToolCallParams> | undefined;

    if (!params?.name) {
      throw createInvalidParams('Missing tool name');
    }

    const result = await toolRouter.callTool(
      params.name,
      params.arguments,
      requestId
    );

    return {
      jsonrpc: '2.0',
      id: req.id!,
      result,
    };
  }
}

export const mcpServer = new MCPServer();
