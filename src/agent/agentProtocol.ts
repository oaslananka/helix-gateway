import { MessageParseError } from "../errors/index.js";
import { z } from 'zod';

/**
 * Agent Protocol v1
 * Versioned protocol for agent-gateway communication
 */

export const AGENT_PROTOCOL_VERSION = 1;

// Base message schema
export const AgentMessageSchema = z.object({
  type: z.string(),
  protocolVersion: z.number().optional(),
});

// Tool schema (MCP-compatible)
export const AgentToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.unknown()).optional(),
    required: z.array(z.string()).optional(),
  }).passthrough(),
});

// Agent capabilities
export const AgentCapabilitiesSchema = z.object({
  tools: z.array(AgentToolSchema),
  resources: z.array(z.unknown()).optional().default([]),
  prompts: z.array(z.unknown()).optional().default([]),
});

// Agent meta information
export const AgentMetaSchema = z.object({
  os: z.string().optional(),
  arch: z.string().optional(),
  agentVersion: z.string().optional(),
  repoRoot: z.string().optional(),
  repoRoots: z.array(z.string()).optional(),
  features: z.record(z.boolean()).optional(),
}).passthrough();

// Register message
export const AgentRegisterMessageSchema = z.object({
  type: z.literal('register'),
  protocolVersion: z.number(),
  agentId: z.string(),
  agentName: z.string(),
  meta: AgentMetaSchema.optional(),
  capabilities: AgentCapabilitiesSchema,
});

// Heartbeat messages
export const AgentPingMessageSchema = z.object({
  type: z.literal('ping'),
  ts: z.number(),
});

export const AgentPongMessageSchema = z.object({
  type: z.literal('pong'),
  ts: z.number(),
});

// Capabilities update
export const AgentCapabilitiesUpdateMessageSchema = z.object({
  type: z.literal('capabilities_update'),
  protocolVersion: z.number(),
  capabilities: AgentCapabilitiesSchema.optional(),
  tools: z.array(AgentToolSchema).optional(),
}).transform((msg) => ({
  ...msg,
  capabilities: msg.capabilities ?? {
    tools: msg.tools ?? [],
    resources: [],
    prompts: [],
  },
}));

// Tool call messages
export const AgentCallRequestSchema = z.object({
  type: z.literal('call'),
  requestId: z.string(),
  domain: z.string(),
  name: z.string(),
  arguments: z.record(z.unknown()).optional(),
  timeoutMs: z.number().optional(),
});

export const AgentCallResultSchema = z.object({
  type: z.literal('call_result'),
  requestId: z.string(),
  ok: z.boolean(),
  result: z.object({
    content: z.array(z.object({
      type: z.string(),
      text: z.string().optional(),
      data: z.string().optional(),
      mimeType: z.string().optional(),
    })),
  }).optional(),
  error: z.object({
    code: z.enum(['TOOL_ERROR', 'TIMEOUT', 'INVALID_ARGUMENTS', 'NOT_FOUND', 'POLICY_DENIED']),
    message: z.string(),
    data: z.unknown().optional(),
  }).optional(),
});

// Type exports
export type AgentTool = z.infer<typeof AgentToolSchema>;
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export type AgentMeta = z.infer<typeof AgentMetaSchema>;
export type AgentRegisterMessage = z.infer<typeof AgentRegisterMessageSchema>;
export type AgentPingMessage = z.infer<typeof AgentPingMessageSchema>;
export type AgentPongMessage = z.infer<typeof AgentPongMessageSchema>;
export type AgentCapabilitiesUpdateMessage = z.infer<typeof AgentCapabilitiesUpdateMessageSchema>;
export type AgentCallRequest = z.infer<typeof AgentCallRequestSchema>;
export type AgentCallResult = z.infer<typeof AgentCallResultSchema>;

export type AgentMessage =
  | AgentRegisterMessage
  | AgentPingMessage
  | AgentPongMessage
  | AgentCapabilitiesUpdateMessage
  | AgentCallResult;

// Validation helpers
export function validateAgentMessage(data: unknown): AgentMessage {
  const base = AgentMessageSchema.parse(data);
  
  switch (base.type) {
    case 'register':
      return AgentRegisterMessageSchema.parse(data);
    case 'ping':
      return AgentPingMessageSchema.parse(data);
    case 'pong':
      return AgentPongMessageSchema.parse(data);
    case 'capabilities_update':
      return AgentCapabilitiesUpdateMessageSchema.parse(data);
    case 'call_result':
      return AgentCallResultSchema.parse(data);
    default:
      throw new MessageParseError(`Unknown agent message type: ${base.type}`);
  }
}

export function isCallResult(msg: AgentMessage): msg is AgentCallResult {
  return msg.type === 'call_result';
}

export function isPing(msg: AgentMessage): msg is AgentPingMessage {
  return msg.type === 'ping';
}

export function isCapabilitiesUpdate(msg: AgentMessage): msg is AgentCapabilitiesUpdateMessage {
  return msg.type === 'capabilities_update';
}
