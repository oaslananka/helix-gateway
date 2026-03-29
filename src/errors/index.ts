// Vanilla TypeScript typed errors (effect dependency gerekmez)
export abstract class HelixError extends Error {
  abstract readonly _tag: string;
  constructor(message: string, public readonly context?: Record<string, unknown>) {
    super(message);
    // Preserve stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }
  get name() { return this._tag; }
}

export class AgentNotFoundError extends HelixError {
  readonly _tag = 'AgentNotFoundError';
  constructor(public readonly agentId: string) {
    super(`Agent not found: ${agentId}`, { agentId });
  }
}

export class AgentAuthError extends HelixError {
  readonly _tag = 'AgentAuthError';
  constructor(public readonly agentId: string, reason: string) {
    super(`Auth failed for agent ${agentId}: ${reason}`, { agentId, reason });
  }
}

export class ToolNotFoundError extends HelixError {
  readonly _tag = 'ToolNotFoundError';
  constructor(public readonly toolName: string) {
    super(`Tool not found: ${toolName}`, { toolName });
  }
}

export class ToolCallTimeoutError extends HelixError {
  readonly _tag = 'ToolCallTimeoutError';
  constructor(public readonly toolName: string, public readonly timeoutMs: number) {
    super(`Tool call timed out after ${timeoutMs}ms: ${toolName}`, { toolName, timeoutMs });
  }
}

export class ToolCallError extends HelixError {
  readonly _tag = 'ToolCallError';
  constructor(
    public readonly toolName: string,
    public readonly agentId: string,
    cause: unknown
  ) {
    super(`Tool call failed: ${toolName} on agent ${agentId}`, {
      toolName,
      agentId,
      cause: String(cause),
    });
  }
}

export class CircuitOpenError extends HelixError {
  readonly _tag = 'CircuitOpenError';
  constructor(public readonly agentId: string) {
    super(`Circuit breaker open for agent: ${agentId}`, { agentId });
  }
}

export class ValidationError extends HelixError {
  readonly _tag = 'ValidationError';
  constructor(message: string, public readonly fields?: Record<string, string>) {
    super(message, { fields });
  }
}

export class RateLimitError extends HelixError {
  readonly _tag = 'RateLimitError';
  constructor(public readonly retryAfterMs: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterMs}ms`, { retryAfterMs });
  }
}

// Type guard utilities
export function isHelixError(err: unknown): err is HelixError {
  return err instanceof HelixError;
}

export function getErrorTag(err: unknown): string {
  if (isHelixError(err)) return err._tag;
  if (err instanceof Error) return err.constructor.name;
  return 'UnknownError';
}

export class MessageParseError extends HelixError {
  readonly _tag = 'MessageParseError';
  constructor(message: string) {
    super(message);
  }
}

export class AgentConnectionError extends HelixError {
  readonly _tag = 'AgentConnectionError';
  constructor(public readonly url: string, public readonly status: number) {
    super(`HTTP ${status} from agent: ${url}`, { url, status });
  }
}
