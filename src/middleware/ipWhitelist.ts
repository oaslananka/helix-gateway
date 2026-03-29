import { Request, Response, NextFunction } from 'express';
import { logger } from '../observability/logger.js';

// ChatGPT IP ranges - UPDATE THIS LIST AS NEEDED
const ALLOWED_IP_RANGES = [
  '20.102.212.0/24',     // ChatGPT Azure US
  '127.0.0.1',           // Localhost for testing
  '::1',                 // IPv6 localhost
  '172.18.0.0/16',       // Docker internal network
];

// CloudFlare IP header
const CF_CONNECTING_IP_HEADER = 'cf-connecting-ip';

function parseIPRange(range: string): { ip: string; mask: number } | null {
  if (!range.includes('/')) {
    return { ip: range, mask: 32 };
  }
  
  const [ip, maskStr] = range.split('/');
  const mask = parseInt(maskStr, 10);
  
  if (isNaN(mask) || mask < 0 || mask > 32) {
    return null;
  }
  
  return { ip, mask };
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.');
  
  if (parts.length !== 4) {
    return 0;
  }
  
  return parts.reduce((acc, part) => {
    const num = parseInt(part, 10);
    return (acc << 8) + (isNaN(num) ? 0 : num);
  }, 0) >>> 0;
}

function isIPInRange(ip: string, range: string): boolean {
  // Handle IPv6 localhost
  if (ip === '::1' && (range === '::1' || range === '127.0.0.1')) {
    return true;
  }
  
  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }
  
  const parsed = parseIPRange(range);
  
  if (!parsed) {
    return false;
  }
  
  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(parsed.ip);
  const mask = parsed.mask === 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - parsed.mask)) >>> 0;
  
  return (ipNum & mask) === (rangeNum & mask);
}

function isIPAllowed(ip: string): boolean {
  return ALLOWED_IP_RANGES.some(range => isIPInRange(ip, range));
}

export function ipWhitelistMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Get the real IP from CloudFlare header first, then fallback to other headers
  const cfIP = req.headers[CF_CONNECTING_IP_HEADER] as string;
  const forwardedFor = req.headers['x-forwarded-for'] as string;
  const realIP = req.headers['x-real-ip'] as string;
  const remoteIP = req.socket.remoteAddress || '';
  
  // Priority: cf-connecting-ip > x-real-ip > x-forwarded-for > remoteAddress
  const clientIP = cfIP || realIP || (forwardedFor ? forwardedFor.split(',')[0].trim() : remoteIP);
  
  if (!clientIP) {
    logger.warn({ requestId: req.id, path: req.path }, 'Unable to determine client IP');
    res.status(403).json({ error: 'Forbidden: Unable to determine client IP' });
    return;
  }
  
  if (!isIPAllowed(clientIP)) {
    logger.warn({ 
      requestId: req.id, 
      path: req.path, 
      clientIP,
      cfIP,
      realIP,
      forwardedFor 
    }, 'IP not in whitelist');
    
    res.status(403).json({ 
      error: 'Forbidden: Your IP is not whitelisted',
      clientIP: clientIP 
    });
    return;
  }
  
  // IP is allowed, proceed
  next();
}
