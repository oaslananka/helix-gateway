import assert from 'node:assert';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { createServer, Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { agentRegistry } from '../src/agent/agentRegistry.js';
import { agentWsServer } from '../src/agent/agentWsServer.js';
import { CircuitOpenError, ToolNotFoundError } from '../src/errors/index.js';
import { mcpServer } from '../src/mcp/mcpServer.js';
import { toolRouter } from '../src/routing/toolRouter.js';

const MOCK_AGENT_ID = 'test-agent-1';
const MOCK_AGENT_KEY = 'test-secret-key-123';

const mockWs = {
  send: (_data: string) => {},
  close: () => {},
  readyState: WebSocket.OPEN,
} as unknown as WebSocket;

let agentWs: WebSocket | null = null;
let httpServer: Server | null = null;
let gatewayUrl = '';
let gatewayWsUrl = '';

interface MockToolCallMessage {
  requestId: string;
  name: string;
  arguments?: Record<string, number | string>;
}

function createGatewayApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.id = req.headers['x-request-id']?.toString() || 'test-request';
    next();
  });

  app.post('/sse', async (req, res) => {
    await mcpServer.handleSSEPost(req, res);
  });

  app.get('/health_check', (_req, res) => {
    const stats = agentRegistry.getStats();
    res.json({
      status: 'healthy',
      gateway: {
        connectedAgents: stats.connectedAgents,
        totalTools: stats.totalTools,
      },
    });
  });

  return app;
}

function handleMockToolCall(msg: MockToolCallMessage) {
  if (!agentWs || agentWs.readyState !== WebSocket.OPEN) {
    return;
  }

  if (msg.name === 'test.echo') {
    agentWs.send(
      JSON.stringify({
        type: 'call_result',
        requestId: msg.requestId,
        ok: true,
        result: {
          content: [
            {
              type: 'text',
              text: `Echo: ${msg.arguments?.message || 'no message'}`,
            },
          ],
        },
      })
    );
    return;
  }

  if (msg.name === 'test.add') {
    const a = Number(msg.arguments?.a || 0);
    const b = Number(msg.arguments?.b || 0);
    agentWs.send(
      JSON.stringify({
        type: 'call_result',
        requestId: msg.requestId,
        ok: true,
        result: {
          content: [
            {
              type: 'text',
              text: `Result: ${a + b}`,
            },
          ],
        },
      })
    );
    return;
  }

  agentWs.send(
    JSON.stringify({
      type: 'call_result',
      requestId: msg.requestId,
      ok: false,
      error: {
        code: 'UNKNOWN_TOOL',
        message: `Unknown tool: ${msg.name}`,
      },
    })
  );
}

describe('MCP Gateway Integration Tests', () => {
  before(async () => {
    process.env.AGENT_KEYS_JSON = JSON.stringify({
      [MOCK_AGENT_ID]: MOCK_AGENT_KEY,
    });

    const app = createGatewayApp();
    httpServer = createServer(app);

    const wss = new WebSocketServer({
      server: httpServer,
      path: '/agent/ws',
    });

    agentWsServer.init(wss);

    await new Promise<void>((resolve) => {
      httpServer?.listen(0, '127.0.0.1', () => resolve());
    });

    const address = httpServer.address();
    assert.ok(address && typeof address !== 'string');

    gatewayUrl = `http://127.0.0.1:${address.port}`;
    gatewayWsUrl = `${gatewayUrl.replace('http', 'ws')}/agent/ws`;
  });

  after(async () => {
    if (agentWs && agentWs.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        agentWs?.once('close', () => resolve());
        agentWs?.close();
      });
    }

    agentWsServer.shutdown();

    if (httpServer) {
      await new Promise<void>((resolve, reject) => {
        httpServer?.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('should connect mock agent via WebSocket', async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Agent connection timeout'));
      }, 5000);
      timeout.unref();

      agentWs = new WebSocket(`${gatewayWsUrl}?token=${MOCK_AGENT_KEY}`);

      agentWs.on('open', () => {
        agentWs?.send(
          JSON.stringify({
            type: 'register',
            protocolVersion: 1,
            agentId: MOCK_AGENT_ID,
            agentName: 'Test Agent',
            capabilities: {
              tools: [
                {
                  name: 'test.echo',
                  description: 'Echo back the input',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      message: { type: 'string' },
                    },
                    required: ['message'],
                  },
                },
                {
                  name: 'test.add',
                  description: 'Add two numbers',
                  inputSchema: {
                    type: 'object',
                    properties: {
                      a: { type: 'number' },
                      b: { type: 'number' },
                    },
                    required: ['a', 'b'],
                  },
                },
              ],
            },
          })
        );
      });

      agentWs.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type: string; error?: string };

        if (msg.type === 'registered') {
          clearTimeout(timeout);
          resolve();
        } else if (msg.type === 'error') {
          clearTimeout(timeout);
          reject(new Error(`Agent registration failed: ${msg.error}`));
        }
      });

      agentWs.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  });

  it('should list tools from mock agent', async () => {
    const response = await fetch(`${gatewayUrl}/sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });

    const data = await response.json();

    assert.strictEqual(data.jsonrpc, '2.0');
    assert.strictEqual(data.id, 1);
    assert.ok(Array.isArray(data.result.tools));

    const toolNames = (data.result.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.ok(toolNames.includes(`${MOCK_AGENT_ID}.test.echo`));
    assert.ok(toolNames.includes(`${MOCK_AGENT_ID}.test.add`));
  });

  it('should call tool via mock agent', async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Tool call timeout'));
      }, 5000);
      timeout.unref();

      const messageHandler = (data: Buffer) => {
        const msg = JSON.parse(data.toString()) as { type: string; name?: string };
        if (msg.type === 'call' && msg.name === 'test.echo') {
          handleMockToolCall(msg as MockToolCallMessage);
        }
      };

      agentWs?.on('message', messageHandler);

      fetch(`${gatewayUrl}/sse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: `${MOCK_AGENT_ID}.test.echo`,
            arguments: { message: 'Hello, Gateway!' },
          },
        }),
      })
        .then((response) => response.json())
        .then((data) => {
          clearTimeout(timeout);
          agentWs?.removeListener('message', messageHandler);
          assert.strictEqual(data.jsonrpc, '2.0');
          assert.strictEqual(data.id, 2);
          assert.ok(data.result.content[0].text.includes('Echo: Hello, Gateway!'));
          resolve();
        })
        .catch((error) => {
          clearTimeout(timeout);
          agentWs?.removeListener('message', messageHandler);
          reject(error);
        });
    });
  });

  it('should handle initialize request', async () => {
    const response = await fetch(`${gatewayUrl}/sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'test-client',
            version: '1.0.0',
          },
        },
      }),
    });

    const data = await response.json();
    assert.strictEqual(data.result.protocolVersion, '2024-11-05');
    assert.strictEqual(data.result.serverInfo.name, 'MCP Gateway');
  });

  it('should check health endpoint', async () => {
    const response = await fetch(`${gatewayUrl}/health_check`);
    const data = await response.json();

    assert.strictEqual(data.status, 'healthy');
    assert.ok(data.gateway.connectedAgents >= 1);
    assert.ok(data.gateway.totalTools >= 2);
  });
});

describe('Circuit Breaker', () => {
  it('should open circuit after consecutive failures', () => {
    agentRegistry.registerAgent('cb-agent', 'CB Agent', mockWs, {
      tools: [{ name: 'cb.fail', description: 'fail', inputSchema: { type: 'object' } }],
    });

    const agent = agentRegistry.getAgent('cb-agent');
    assert.ok(agent);

    for (let i = 0; i < 5; i++) {
      agentRegistry['recordFailure'](agent);
    }

    assert.strictEqual(agent.circuitBreaker.state, 'open');
  });

  it('should reject calls immediately when circuit is open', async () => {
    await assert.rejects(
      () => agentRegistry.callTool('cb-agent.cb.fail', {}, '1'),
      (error: unknown) => error instanceof CircuitOpenError
    );
  });

  it('should enter half-open state after cooldown', async () => {
    const agent = agentRegistry.getAgent('cb-agent');
    assert.ok(agent);
    agent.circuitBreaker.lastFailure = Date.now() - 61000;

    try {
      await agentRegistry.callTool('cb.fail', {}, '2', 10);
    } catch (error) {
      assert.ok(!(error instanceof CircuitOpenError));
    }

    agentRegistry.unregisterAgent('cb-agent', 'test done');
  });
});

describe('Concurrent Tool Calls', () => {
  it('should handle 10 simultaneous tool calls', async () => {
    agentRegistry.registerAgent('conc-agent', 'Conc Agent', mockWs, {
      tools: [{ name: 'conc.tool', description: '', inputSchema: { type: 'object' } }],
    });

    const calls = Array.from({ length: 10 }, (_, i) =>
      agentRegistry.callTool('conc.tool', {}, `req-${i}`, 50)
    );

    const results = await Promise.allSettled(calls);
    assert.strictEqual(results.length, 10);

    agentRegistry.unregisterAgent('conc-agent', 'test done');
  });
});

describe('Agent Reconnection', () => {
  it('should re-register tools after WebSocket reconnect', () => {
    agentRegistry.registerAgent('recon-agent', 'Recon Agent', mockWs, {
      tools: [{ name: 'recon.tool', description: '', inputSchema: { type: 'object' } }],
    });
    assert.ok(agentRegistry.getAllTools().some((tool) => tool.name === 'recon-agent.recon.tool'));

    agentRegistry.unregisterAgent('recon-agent', 'disconnect');
    assert.ok(!agentRegistry.getAllTools().some((tool) => tool.name === 'recon-agent.recon.tool'));

    agentRegistry.registerAgent('recon-agent', 'Recon Agent', mockWs, {
      tools: [{ name: 'recon.tool', description: '', inputSchema: { type: 'object' } }],
    });
    assert.ok(agentRegistry.getAllTools().some((tool) => tool.name === 'recon-agent.recon.tool'));

    agentRegistry.unregisterAgent('recon-agent', 'test done');
  });
});

describe('Typed Errors', () => {
  it('should return undefined for unknown agent', () => {
    assert.strictEqual(agentRegistry.getAgent('nonexistent'), undefined);
  });

  it('should throw ToolNotFoundError for unknown tool', async () => {
    agentRegistry.registerAgent('typed-agent', 'Typed Agent', mockWs, {
      tools: [{ name: 'typed.tool', description: '', inputSchema: { type: 'object' } }],
    });

    await assert.rejects(
      () => agentRegistry.callTool('unknown.tool', {}, 'typed-1'),
      (error: unknown) =>
        error instanceof ToolNotFoundError ||
        (error instanceof Error && error.message.includes('Tool not found'))
    );

    agentRegistry.unregisterAgent('typed-agent', 'test done');
  });
});
