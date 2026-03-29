import { MCP_ERROR_CODES, MCPError } from './mcpTypes.js';

export class MCPErrorClass extends Error {
  public code: number;
  public data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'MCPError';
    this.code = code;
    this.data = data;
  }

  toJSON(): MCPError {
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }
}

export function createParseError(message: string, data?: unknown): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.PARSE_ERROR, message, data);
}

export function createInvalidRequest(message: string, data?: unknown): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.INVALID_REQUEST, message, data);
}

export function createMethodNotFound(method: string): MCPErrorClass {
  return new MCPErrorClass(
    MCP_ERROR_CODES.METHOD_NOT_FOUND,
    `Method not found: ${method}`
  );
}

export function createInvalidParams(message: string, data?: unknown): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.INVALID_PARAMS, message, data);
}

export function createInternalError(message: string, data?: unknown): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.INTERNAL_ERROR, message, data);
}

export function createToolNotFound(toolName: string): MCPErrorClass {
  return new MCPErrorClass(
    MCP_ERROR_CODES.TOOL_NOT_FOUND,
    `Tool not found: ${toolName}`
  );
}

export function createToolExecutionError(message: string, data?: unknown): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.TOOL_EXECUTION_ERROR, message, data);
}

export function createTimeoutError(message: string): MCPErrorClass {
  return new MCPErrorClass(MCP_ERROR_CODES.TIMEOUT, message);
}

export function createNoAgentsAvailable(): MCPErrorClass {
  return new MCPErrorClass(
    MCP_ERROR_CODES.NO_AGENTS_AVAILABLE,
    'No agents are currently available'
  );
}

export function createAmbiguousToolError(toolName: string): MCPErrorClass {
  return new MCPErrorClass(
    MCP_ERROR_CODES.AMBIGUOUS_TOOL,
    `Ambiguous tool name: ${toolName}. Tool must be prefixed with agent ID.`
  );
}
