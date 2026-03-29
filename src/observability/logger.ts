import pino from 'pino';
import { Transform } from 'stream';

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_BUFFER_SIZE = parseInt(process.env.LOG_BUFFER_SIZE || '1000', 10);

// Log buffer for admin panel access
interface LogEntry {
  timestamp: string;
  level: string;
  msg: string;
  context?: Record<string, unknown>;
}

const logBuffer: LogEntry[] = [];

// Custom transform stream to capture logs
class LogCaptureStream extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _transform(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) {
    try {
      const logLine = typeof chunk === 'string' ? chunk : chunk.toString();
      const parsed = JSON.parse(logLine);

      const entry: LogEntry = {
        timestamp: new Date(parsed.time).toISOString(),
        level: pino.levels.labels[parsed.level] || String(parsed.level),
        msg: parsed.msg || '',
        context: { ...parsed },
      };

      // Remove standard fields from context
      delete entry.context?.time;
      delete entry.context?.level;
      delete entry.context?.msg;
      delete entry.context?.pid;
      delete entry.context?.hostname;

      logBuffer.push(entry);

      // Trim buffer if needed
      while (logBuffer.length > LOG_BUFFER_SIZE) {
        logBuffer.shift();
      }
    } catch {
      // Ignore parse errors
    }

    // Pass through to stdout
    this.push(chunk);
    callback();
  }
}

// Create streams
const captureStream = new LogCaptureStream();
captureStream.pipe(process.stdout);

const isProd = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: LOG_LEVEL,
  ...(isProd ? {} : {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss',
        ignore: 'pid,hostname',
        singleLine: true,
        hideObject: false,
      },
    },
  }),
}, isProd ? captureStream : undefined) as pino.Logger & { getRecentLogs: typeof getRecentLogs };

// Function to get recent logs for admin panel
export function getRecentLogs(limit: number = 100, level?: string): LogEntry[] {
  let logs = logBuffer.slice(-limit);

  if (level) {
    logs = logs.filter(l => l.level === level);
  }

  return logs.reverse(); // Most recent first
}

// Attach getRecentLogs to logger for convenience
(logger as any).getRecentLogs = getRecentLogs;

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

export default logger;
