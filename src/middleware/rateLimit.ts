import rateLimit from 'express-rate-limit';

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10);
const RATE_LIMIT_MAX_REQUESTS = parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100', 10);
const RATE_LIMIT_AGENT_WS_MAX = parseInt(process.env.RATE_LIMIT_AGENT_WS_MAX || '10', 10);

// Rate limiter for general API requests
export const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX_REQUESTS,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip rate limiting for GET /sse (SSE connection itself, not the handshake)
  skip: (req): boolean => {
    // Only skip if it's an actual SSE connection (has Accept: text/event-stream)
    return req.method === 'GET' && 
           req.path === '/sse' && 
           (req.headers.accept?.includes('text/event-stream') || false);
  },
});

// Rate limiter for agent WebSocket connections
export const agentWsRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_AGENT_WS_MAX,
  message: 'Too many agent connection attempts from this IP.',
  standardHeaders: true,
  legacyHeaders: false,
});
