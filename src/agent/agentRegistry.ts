import { AgentNotFoundError, ToolNotFoundError, CircuitOpenError, ToolCallTimeoutError } from '../errors/index.js';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import {
  AgentCapabilities,
  AgentTool,
  AgentCallRequest,
  AgentCallResult,
} from './agentProtocol.js';

const AGENT_CALL_TIMEOUT_MS = parseInt(process.env.AGENT_CALL_TIMEOUT_MS || '30000', 10);
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = parseInt(
  process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD || '5',
  10
);
const CIRCUIT_BREAKER_RESET_TIMEOUT_MS = parseInt(
  process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS || '60000',
  10
);
const AGENT_CAPABILITY_CACHE_TTL_MS = parseInt(
  process.env.AGENT_CAPABILITY_CACHE_TTL_MS || '60000',
  10
);
const AGENT_AUTO_NAMESPACE = process.env.AGENT_AUTO_NAMESPACE !== 'false';

function namespaceToolName(agentId: string, toolName: string): string {
  return toolName.startsWith(`${agentId}.`) ? toolName : `${agentId}.${toolName}`;
}

function stripAgentNamespace(agentId: string, toolName: string): string {
  return toolName.startsWith(`${agentId}.`) ? toolName.slice(agentId.length + 1) : toolName;
}

interface PendingCall {
  resolve: (result: AgentCallResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface CircuitBreakerState {
  failureCount: number;
  lastFailure: number;
  state: 'closed' | 'open' | 'half-open';
}

interface RegisteredAgent {
  agentId: string;
  agentName: string;
  ws: WebSocket;
  capabilities: AgentCapabilities;
  meta?: {
    os?: string;
    arch?: string;
    agentVersion?: string;
    repoRoot?: string;
  };
  lastSeen: number;
  registeredAt: number;
  circuitBreaker: CircuitBreakerState;
  pendingCalls: Map<string, PendingCall>;
}

export class AgentRegistry extends EventEmitter {
  private agents: Map<string, RegisteredAgent> = new Map();
  private toolCache: Map<string, { tools: AgentTool[]; timestamp: number }> = new Map();
  private cleanupTimer: NodeJS.Timeout;

  constructor() {
    super();
    
    // Periodic cleanup of stale cache entries
    this.cleanupTimer = setInterval(() => {
      this.cleanupStaleCache();
    }, 60000);
    this.cleanupTimer.unref();
  }

  registerAgent(
    agentId: string,
    agentName: string,
    ws: WebSocket,
    capabilities: AgentCapabilities,
    meta?: { os?: string; arch?: string; agentVersion?: string; repoRoot?: string }
  ): void {
    const existing = this.agents.get(agentId);
    
    if (existing) {
      logger.warn({ agentId }, 'Agent already registered, will be replaced');
      this.unregisterAgent(agentId, 'duplicate_connection');
    }

    const agent: RegisteredAgent = {
      agentId,
      agentName,
      ws,
      capabilities,
      meta,
      lastSeen: Date.now(),
      registeredAt: Date.now(),
      circuitBreaker: {
        failureCount: 0,
        lastFailure: 0,
        state: 'closed',
      },
      pendingCalls: new Map(),
    };

    this.agents.set(agentId, agent);
    
    // Update metrics
    metrics.connectedAgents.set({ agent_id: agentId }, 1);
    metrics.agentConnectsTotal.inc({ agent_id: agentId });
    
    // Invalidate cache for this agent
    this.toolCache.delete(agentId);
    
    logger.info({
      agentId,
      agentName,
      toolCount: capabilities.tools.length,
    }, 'Agent registered');

    this.emit('agent_registered', agent);
  }

  unregisterAgent(agentId: string, reason: string): void {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      return;
    }

    // Reject all pending calls
    for (const [requestId, call] of agent.pendingCalls.entries()) {
      clearTimeout(call.timer);
      call.reject(new Error(`Agent disconnected: ${reason}`));
      agent.pendingCalls.delete(requestId);
    }

    // Close WebSocket if still open
    if (agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.close();
    }

    this.agents.delete(agentId);
    
    // Update metrics
    metrics.connectedAgents.set({ agent_id: agentId }, 0);
    metrics.agentDisconnectsTotal.inc({ agent_id: agentId, reason });
    
    // Invalidate cache
    this.toolCache.delete(agentId);
    
    logger.info({ agentId, reason }, 'Agent unregistered');

    this.emit('agent_unregistered', agentId);
  }

  updateCapabilities(agentId: string, capabilities: AgentCapabilities): void {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      logger.warn({ agentId }, 'Cannot update capabilities: agent not found');
      return;
    }

    agent.capabilities = capabilities;
    agent.lastSeen = Date.now();
    
    // Invalidate cache
    this.toolCache.delete(agentId);
    
    logger.info({
      agentId,
      toolCount: capabilities.tools.length,
    }, 'Agent capabilities updated');

    this.emit('capabilities_updated', agentId);
  }

  updateLastSeen(agentId: string): void {
    const agent = this.agents.get(agentId);
    
    if (agent) {
      agent.lastSeen = Date.now();
    }
  }

  getAgent(agentId: string): RegisteredAgent | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): RegisteredAgent[] {
    return Array.from(this.agents.values());
  }

  getConnectedAgentIds(): string[] {
    return Array.from(this.agents.keys());
  }

  getHealthyAgents(): RegisteredAgent[] {
    return this.getAllAgents().filter(agent => {
      return agent.circuitBreaker.state !== 'open';
    });
  }

  getAllTools(): AgentTool[] {
    const allTools: AgentTool[] = [];
    
    for (const agent of this.getHealthyAgents()) {
      const tools = this.getAgentTools(agent.agentId);
      allTools.push(...tools);
    }
    
    // Update metrics
    metrics.toolsCount.set(allTools.length);
    
    return allTools;
  }

  getAgentTools(agentId: string): AgentTool[] {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      return [];
    }

    // Apply namespacing if enabled
    const tools = AGENT_AUTO_NAMESPACE
      ? agent.capabilities.tools.map(tool => ({
          ...tool,
          name: namespaceToolName(agentId, tool.name),
        }))
      : agent.capabilities.tools;

    
    return tools;
  }

  findToolAgent(toolName: string): string | null {
    // Strategy 1: Check if tool has explicit prefix
    const parts = toolName.split('.');
    
    if (parts.length >= 2) {
      const potentialAgentId = parts[0];
      
      if (this.agents.has(potentialAgentId)) {
        return potentialAgentId;
      }
    }

    // Strategy 2: If only one agent is connected and ALLOW_SINGLE_AGENT_NO_PREFIX is true
    const allowSingleAgent = process.env.ALLOW_SINGLE_AGENT_NO_PREFIX !== 'false';
    const healthyAgents = this.getHealthyAgents();
    
    if (allowSingleAgent && healthyAgents.length === 1) {
      // Check if this agent has the tool (without prefix)
      const agent = healthyAgents[0];
      const hasTool = agent.capabilities.tools.some(t => t.name === toolName);
      
      if (hasTool) {
        return agent.agentId;
      }
    }

    // Strategy 3: Search all agents for exact match
    for (const agent of healthyAgents) {
      const tools = this.getAgentTools(agent.agentId);
      const hasTool = tools.some(t => t.name === toolName);
      
      if (hasTool) {
        return agent.agentId;
      }
    }

    return null;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    requestId: string,
    timeoutMs?: number
  ): Promise<AgentCallResult> {
    const agentId = this.findToolAgent(toolName);
    
    if (!agentId) {
      throw new ToolNotFoundError(toolName);
    }

    const agent = this.agents.get(agentId);
    
    if (!agent) {
      throw new AgentNotFoundError(agentId);
    }

    // Check circuit breaker
    if (!this.checkCircuitBreaker(agent)) {
      throw new CircuitOpenError(agentId);
    }

    const timeout = timeoutMs || AGENT_CALL_TIMEOUT_MS;
    
    return new Promise<AgentCallResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        agent.pendingCalls.delete(requestId);
        this.recordFailure(agent);
        reject(new ToolCallTimeoutError(toolName, timeout));
      }, timeout);

      agent.pendingCalls.set(requestId, { resolve, reject, timer });

      const callRequest: AgentCallRequest = {
        type: 'call',
        requestId,
        domain: 'tools',
        name: stripAgentNamespace(agentId, toolName),
        arguments: args,
        timeoutMs: timeout,
      };

      try {
        agent.ws.send(JSON.stringify(callRequest));
      } catch (error) {
        clearTimeout(timer);
        agent.pendingCalls.delete(requestId);
        this.recordFailure(agent);
        reject(error);
      }
    });
  }

  handleCallResult(agentId: string, result: AgentCallResult): void {
    const agent = this.agents.get(agentId);
    
    if (!agent) {
      logger.warn({ agentId, requestId: result.requestId }, 'Call result from unknown agent');
      return;
    }

    const pending = agent.pendingCalls.get(result.requestId);
    
    if (!pending) {
      logger.warn({
        agentId,
        requestId: result.requestId,
      }, 'Call result for unknown request');
      return;
    }

    clearTimeout(pending.timer);
    agent.pendingCalls.delete(result.requestId);

    if (result.ok) {
      this.recordSuccess(agent);
      pending.resolve(result);
    } else {
      this.recordFailure(agent);
      pending.reject(new Error(result.error?.message || 'Tool call failed'));
    }
  }

  private checkCircuitBreaker(agent: RegisteredAgent): boolean {
    const cb = agent.circuitBreaker;
    const now = Date.now();

    if (cb.state === 'open') {
      // Check if we should try half-open
      if (now - cb.lastFailure > CIRCUIT_BREAKER_RESET_TIMEOUT_MS) {
        cb.state = 'half-open';
        cb.failureCount = 0;
        logger.info({ agentId: agent.agentId }, 'Circuit breaker half-open');
        return true;
      }
      return false;
    }

    return true;
  }

  private recordSuccess(agent: RegisteredAgent): void {
    const cb = agent.circuitBreaker;
    
    if (cb.state === 'half-open') {
      cb.state = 'closed';
      cb.failureCount = 0;
      logger.info({ agentId: agent.agentId }, 'Circuit breaker closed');
    }
  }

  private recordFailure(agent: RegisteredAgent): void {
    const cb = agent.circuitBreaker;
    cb.failureCount++;
    cb.lastFailure = Date.now();

    if (cb.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      cb.state = 'open';
      logger.warn({
        agentId: agent.agentId,
        failureCount: cb.failureCount,
      }, 'Circuit breaker opened');
    }
  }

  private cleanupStaleCache(): void {
    const now = Date.now();
    
    for (const [agentId, cached] of this.toolCache.entries()) {
      if (now - cached.timestamp > AGENT_CAPABILITY_CACHE_TTL_MS * 2) {
        this.toolCache.delete(agentId);
      }
    }
  }

  getStats() {
    const agents = this.getAllAgents();
    
    return {
      connectedAgents: agents.length,
      healthyAgents: this.getHealthyAgents().length,
      totalTools: this.getAllTools().length,
      agents: agents.map(a => ({
        agentId: a.agentId,
        agentName: a.agentName,
        toolCount: a.capabilities.tools.length,
        state: a.circuitBreaker.state,
        uptime: Date.now() - a.registeredAt,
        lastSeen: Date.now() - a.lastSeen,
        lastCapabilitiesAt: a.lastSeen,
        meta: a.meta,
      })),
    };
  }
}

// Singleton instance
export const agentRegistry = new AgentRegistry();
