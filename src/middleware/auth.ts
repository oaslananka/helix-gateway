import { Request, Response, NextFunction } from 'express';
import { logger } from '../observability/logger.js';

function getInternalBearerToken(): string | undefined {
  return process.env.INTERNAL_BEARER_TOKEN;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const internalBearerToken = getInternalBearerToken();

  // If no internal bearer token is configured, skip auth
  if (!internalBearerToken) {
    return next();
  }

  // Check query parameter first (for ChatGPT Actions)
  const queryToken = req.query.bearer as string;
  if (queryToken && queryToken === internalBearerToken) {
    return next();
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ requestId: req.id, path: req.path }, 'Missing or invalid Authorization header');
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid Authorization header' });
  }

  const token = authHeader.substring(7);
  
  if (token !== internalBearerToken) {
    logger.warn({ requestId: req.id, path: req.path }, 'Invalid bearer token');
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }

  next();
}

// Agent WebSocket authentication
export function validateAgentAuth(agentId: string, providedKey: string): boolean {
  const agentKeysJson = process.env.AGENT_KEYS_JSON;
  
  if (!agentKeysJson) {
    logger.error('AGENT_KEYS_JSON not configured');
    return false;
  }

  try {
    const agentKeys = JSON.parse(agentKeysJson) as Record<string, string>;
    const expectedKey = agentKeys[agentId];
    
    if (!expectedKey) {
      logger.warn({ agentId }, 'Unknown agent ID');
      return false;
    }

    return expectedKey === providedKey;
  } catch (error) {
    logger.error({ error }, 'Failed to parse AGENT_KEYS_JSON');
    return false;
  }
}
