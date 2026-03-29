import { AgentConnectionError } from "../errors/index.js";
import { logger } from '../observability/logger.js';
import { agentRegistry } from './agentRegistry.js';
import { AgentCapabilities, AgentCallRequest, AgentCallResult } from './agentProtocol.js';
import { WebSocket } from 'ws';

const AGENT_HTTP_POLL_INTERVAL_MS = parseInt(
  process.env.AGENT_HTTP_POLL_INTERVAL_MS || '30000',
  10
);

interface HttpAgent {
  agentId: string;
  baseUrl: string;
  pollInterval: NodeJS.Timeout | null;
  mockWs: MockWebSocket;
}

/**
 * Mock WebSocket for HTTP agents to integrate with existing registry
 */
class MockWebSocket extends WebSocket {
  private httpAgent: HttpAgent;
  
  constructor(agentId: string, baseUrl: string) {
    // Create a mock WebSocket that won't actually connect
    super('ws://localhost:0', { timeout: 0 });
    this.httpAgent = { agentId, baseUrl, pollInterval: null, mockWs: this as any };
  }

  send(data: string) {
    // Handle outgoing messages (call requests) via HTTP
    try {
      const message = JSON.parse(data);
      if (message.type === 'call') {
        this.handleHttpCall(message);
      }
    } catch (error) {
      logger.error({ error, agentId: this.httpAgent.agentId }, 'Failed to send HTTP call');
    }
  }

  private async handleHttpCall(callRequest: AgentCallRequest) {
    try {
      const response = await fetch(`${this.httpAgent.baseUrl}/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: callRequest.name,
          arguments: callRequest.arguments,
        }),
        signal: AbortSignal.timeout(callRequest.timeoutMs || 30000),
      });

      if (!response.ok) {
        throw new AgentConnectionError(response.url, response.status);
      }

      const result = await response.json() as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> };
      
      // Simulate incoming message
      const callResult: AgentCallResult = {
        type: 'call_result',
        requestId: callRequest.requestId,
        ok: true,
        result,
      };

      agentRegistry.handleCallResult(this.httpAgent.agentId, callResult);
    } catch (error) {
      const callResult: AgentCallResult = {
        type: 'call_result',
        requestId: callRequest.requestId,
        ok: false,
        error: {
          code: 'TOOL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };

      agentRegistry.handleCallResult(this.httpAgent.agentId, callResult);
    }
  }

  close() {
    // Cleanup
    if (this.httpAgent.pollInterval) {
      clearInterval(this.httpAgent.pollInterval);
    }
  }
}

export class AgentHttpPoller {
  private agents: Map<string, HttpAgent> = new Map();

  init() {
    const agentHttpUrlsJson = process.env.AGENT_HTTP_URLS_JSON;
    
    if (!agentHttpUrlsJson) {
      logger.info('HTTP polling mode not configured (AGENT_HTTP_URLS_JSON not set)');
      return;
    }

    try {
      const agentUrls = JSON.parse(agentHttpUrlsJson) as Record<string, string>;
      
      for (const [agentId, baseUrl] of Object.entries(agentUrls)) {
        this.startPolling(agentId, baseUrl);
      }

      logger.info({ count: Object.keys(agentUrls).length }, 'HTTP polling mode initialized');
    } catch (error) {
      logger.error({ error }, 'Failed to parse AGENT_HTTP_URLS_JSON');
    }
  }

  private startPolling(agentId: string, baseUrl: string) {
    const mockWs = new MockWebSocket(agentId, baseUrl);
    
    const agent: HttpAgent = {
      agentId,
      baseUrl,
      pollInterval: null,
      mockWs,
    };

    this.agents.set(agentId, agent);

    // Initial capabilities fetch
    this.fetchCapabilities(agent);

    // Setup polling
    agent.pollInterval = setInterval(() => {
      this.fetchCapabilities(agent);
    }, AGENT_HTTP_POLL_INTERVAL_MS);

    logger.info({ agentId, baseUrl }, 'Started HTTP polling for agent');
  }

  private async fetchCapabilities(agent: HttpAgent) {
    try {
      const response = await fetch(`${agent.baseUrl}/capabilities`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new AgentConnectionError(response.url, response.status);
      }

      const data = await response.json() as {
        tools?: Array<{
          name: string;
          description: string;
          inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
        }>;
        resources?: unknown[];
        prompts?: unknown[];
        agentName?: string;
        meta?: { os?: string; arch?: string; agentVersion?: string; repoRoot?: string };
      };
      
      const capabilities: AgentCapabilities = {
        tools: data.tools || [],
        resources: data.resources || [],
        prompts: data.prompts || [],
      };

      // Check if agent is already registered
      const existing = agentRegistry.getAgent(agent.agentId);
      
      if (!existing) {
        // Register for the first time
        agentRegistry.registerAgent(
          agent.agentId,
          data.agentName || agent.agentId,
          agent.mockWs as any,
          capabilities,
          data.meta
        );
        logger.info({ agentId: agent.agentId }, 'HTTP agent registered');
      } else {
        // Update capabilities
        agentRegistry.updateCapabilities(agent.agentId, capabilities);
        logger.debug({ agentId: agent.agentId }, 'HTTP agent capabilities updated');
      }
    } catch (error) {
      logger.error({ error, agentId: agent.agentId }, 'Failed to fetch agent capabilities via HTTP');
    }
  }

  shutdown() {
    for (const agent of this.agents.values()) {
      if (agent.pollInterval) {
        clearInterval(agent.pollInterval);
      }
      agentRegistry.unregisterAgent(agent.agentId, 'http_poller_shutdown');
    }
    this.agents.clear();
    logger.info('HTTP polling mode shut down');
  }
}

export const agentHttpPoller = new AgentHttpPoller();
