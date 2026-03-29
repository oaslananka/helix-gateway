import { Registry, Counter, Gauge, Histogram } from 'prom-client';

const ENABLE_METRICS = process.env.ENABLE_METRICS !== 'false';

export class Metrics {
  private registry: Registry;

  // Gauges
  public connectedAgents: Gauge<string>;
  public toolsCount: Gauge<string>;

  // Counters
  public toolCallsTotal: Counter<string>;
  public toolCallErrorsTotal: Counter<string>;
  public agentDisconnectsTotal: Counter<string>;
  public agentConnectsTotal: Counter<string>;
  public httpRequestsTotal: Counter<string>;

  // Histograms
  public toolCallLatency: Histogram<string>;
  public httpRequestDuration: Histogram<string>;

  constructor() {
    this.registry = new Registry();

    if (!ENABLE_METRICS) {
      // Create dummy metrics that do nothing
      this.connectedAgents = new Gauge({ name: 'dummy', help: 'dummy', registers: [] });
      this.toolsCount = new Gauge({ name: 'dummy2', help: 'dummy', registers: [] });
      this.toolCallsTotal = new Counter({ name: 'dummy3', help: 'dummy', registers: [] });
      this.toolCallErrorsTotal = new Counter({ name: 'dummy4', help: 'dummy', registers: [] });
      this.agentDisconnectsTotal = new Counter({ name: 'dummy5', help: 'dummy', registers: [] });
      this.agentConnectsTotal = new Counter({ name: 'dummy6', help: 'dummy', registers: [] });
      this.httpRequestsTotal = new Counter({ name: 'dummy7', help: 'dummy', registers: [] });
      this.toolCallLatency = new Histogram({ name: 'dummy8', help: 'dummy', registers: [] });
      this.httpRequestDuration = new Histogram({ name: 'dummy9', help: 'dummy', registers: [] });
      return;
    }

    // Connected agents gauge
    this.connectedAgents = new Gauge({
      name: 'mcp_gateway_connected_agents',
      help: 'Number of currently connected agents',
      labelNames: ['agent_id'],
      registers: [this.registry],
    });

    // Tools count gauge
    this.toolsCount = new Gauge({
      name: 'mcp_gateway_tools_count',
      help: 'Total number of available tools',
      registers: [this.registry],
    });

    // Tool calls counter
    this.toolCallsTotal = new Counter({
      name: 'mcp_gateway_tool_calls_total',
      help: 'Total number of tool calls',
      labelNames: ['tool_name', 'agent_id', 'status'],
      registers: [this.registry],
    });

    // Tool call errors counter
    this.toolCallErrorsTotal = new Counter({
      name: 'mcp_gateway_tool_call_errors_total',
      help: 'Total number of tool call errors',
      labelNames: ['tool_name', 'agent_id', 'error_type'],
      registers: [this.registry],
    });

    // Agent disconnects counter
    this.agentDisconnectsTotal = new Counter({
      name: 'mcp_gateway_agent_disconnects_total',
      help: 'Total number of agent disconnections',
      labelNames: ['agent_id', 'reason'],
      registers: [this.registry],
    });

    // Agent connects counter
    this.agentConnectsTotal = new Counter({
      name: 'mcp_gateway_agent_connects_total',
      help: 'Total number of agent connections',
      labelNames: ['agent_id'],
      registers: [this.registry],
    });

    // HTTP requests counter
    this.httpRequestsTotal = new Counter({
      name: 'mcp_gateway_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'path', 'status'],
      registers: [this.registry],
    });

    // Tool call latency histogram
    this.toolCallLatency = new Histogram({
      name: 'mcp_gateway_tool_call_latency_ms',
      help: 'Tool call latency in milliseconds',
      labelNames: ['tool_name', 'agent_id'],
      buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
      registers: [this.registry],
    });

    // HTTP request duration histogram
    this.httpRequestDuration = new Histogram({
      name: 'mcp_gateway_http_request_duration_ms',
      help: 'HTTP request duration in milliseconds',
      labelNames: ['method', 'path', 'status'],
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
      registers: [this.registry],
    });
  }

  async getMetrics(): Promise<string> {
    if (!ENABLE_METRICS) {
      return '# Metrics disabled\n';
    }
    return this.registry.metrics();
  }

  getRegistry(): Registry {
    return this.registry;
  }

  // Get a summary of metrics for admin panel
  getMetricsSummary(): Record<string, unknown> {
    return {
      enabled: ENABLE_METRICS,
      timestamp: new Date().toISOString(),
    };
  }
}

// Singleton instance
export const metrics = new Metrics();
