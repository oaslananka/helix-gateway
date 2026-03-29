import { ToolNotFoundError } from "../errors/index.js";
import { randomUUID } from 'crypto';
import { getTracer, withSpan } from '../observability/tracing.js';

const tracer = getTracer('helix-gateway.tool-router');

import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';
import { agentRegistry } from '../agent/agentRegistry.js';
import { MCPTool, MCPToolResult } from '../mcp/mcpTypes.js';
import {
  createNoAgentsAvailable,
  createAmbiguousToolError,
  createToolExecutionError,
  createTimeoutError,
} from '../mcp/mcpErrors.js';

export class ToolRouter {
  /**
   * Get all available tools from all healthy agents
   */
  async listTools(): Promise<MCPTool[]> {
    const tools = agentRegistry.getAllTools();
    
    if (tools.length === 0) {
      logger.warn('No tools available from any agent');
    }

    logger.debug({ count: tools.length }, 'Listed tools');
    
    return tools;
  }

  /**
   * Route a tool call to the appropriate agent
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown> | undefined,
    requestId?: string
  ): Promise<MCPToolResult> {
    return withSpan(
      tracer,
      'gateway.tool_call',
      {
        'tool.name': toolName,
        'request.id': requestId || 'unknown',
      },
      async (span) => {
    const callId = requestId || randomUUID();
    const startTime = Date.now();

    logger.info({ toolName, agentId: agentRegistry.findToolAgent(toolName) || 'unknown', args }, '🔧 Tool call started');

    try {
      // Check if any agents are available
      const healthyAgents = agentRegistry.getHealthyAgents();
      
      if (healthyAgents.length === 0) {
        throw createNoAgentsAvailable();
      }

      // Find the agent that owns this tool
      const agentId = agentRegistry.findToolAgent(toolName);
      if (agentId) span.setAttribute('agent.id', agentId);
      
      if (!agentId) {
        // Check if the tool exists at all
        const allTools = agentRegistry.getAllTools();
        const toolExists = allTools.some(t => t.name === toolName);
        
        if (!toolExists) {
          throw new ToolNotFoundError(toolName);
        } else {
          // Tool exists but routing is ambiguous
          throw createAmbiguousToolError(toolName);
        }
      }

      // Call the tool via agent registry
      const result = await agentRegistry.callTool(toolName, args, callId);

      const duration = Date.now() - startTime;

      // Record metrics
      metrics.toolCallsTotal.inc({
        tool_name: toolName,
        agent_id: agentId,
        status: result.ok ? 'success' : 'error',
      });
      
      metrics.toolCallLatency.observe(
        { tool_name: toolName, agent_id: agentId },
        duration
      );

      logger.info({
        toolName,
        agentId,
        callId,
        duration,
        success: result.ok,
      }, '✅ Tool call completed');

      // Convert agent result to MCP result
      if (!result.ok) {
        metrics.toolCallErrorsTotal.inc({
          tool_name: toolName,
          agent_id: agentId,
          error_type: result.error?.code || 'unknown',
        });
        
        throw createToolExecutionError(
          result.error?.message || 'Tool execution failed',
          result.error
        );
      }

      const toolResult: MCPToolResult = result.result
        ? (result.result as MCPToolResult)
        : { content: [{ type: 'text' as const, text: 'No result returned' }] };

      return toolResult;
      
    } catch (error) {
      const duration = Date.now() - startTime;
      
      logger.error({
        toolName,
        callId,
        duration,
        error: error instanceof Error ? error.message : String(error),
      }, '❌ Tool call failed');

      // Record error metrics if we know the agent
      const agentId = agentRegistry.findToolAgent(toolName);
      
      if (agentId) {
        metrics.toolCallErrorsTotal.inc({
          tool_name: toolName,
          agent_id: agentId,
          error_type: error instanceof Error && error.name === 'MCPError' 
            ? 'mcp_error' 
            : error instanceof Error && error.message.includes('timeout')
              ? 'timeout'
              : 'unknown',
        });
      }

      // Re-throw MCP errors as-is
      if (error instanceof Error && error.name === 'MCPError') {
        throw error;
      }

      // Convert timeout errors
      if (error instanceof Error && error.message.includes('timeout')) {
        throw createTimeoutError(error.message);
      }

      // Convert other errors
      throw createToolExecutionError(
        error instanceof Error ? error.message : String(error)
      );
    }
      }
    );
  }

  /**
   * Get statistics about tool routing
   */
  getStats() {
    const agents = agentRegistry.getStats();
    const tools = agentRegistry.getAllTools();
    
    // Group tools by agent
    const toolsByAgent: Record<string, string[]> = {};
    
    for (const agent of agentRegistry.getAllAgents()) {
      const agentTools = agentRegistry.getAgentTools(agent.agentId);
      toolsByAgent[agent.agentId] = agentTools.map(t => t.name);
    }

    return {
      totalTools: tools.length,
      totalAgents: agents.connectedAgents,
      healthyAgents: agents.healthyAgents,
      toolsByAgent,
    };
  }
}

export const toolRouter = new ToolRouter();
