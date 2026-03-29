# Example Agent Implementation

A complete example of how to build an agent that connects to the MCP Gateway.

## Simple TypeScript Agent

```typescript
import WebSocket from "ws";
import { readFileSync } from "fs";
import { execSync } from "child_process";

// Configuration
const GATEWAY_URL = process.env.GATEWAY_URL || "ws://localhost:3000/agent/ws";
const AGENT_ID = process.env.AGENT_ID || "example-agent";
const AGENT_KEY = process.env.AGENT_KEY || "your-secret-key";

class MCPAgent {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 5000;

  constructor() {
    this.connect();
  }

  private connect() {
    console.log(`Connecting to gateway: ${GATEWAY_URL}`);

    this.ws = new WebSocket(`${GATEWAY_URL}?token=${AGENT_KEY}`);

    this.ws.on("open", () => {
      console.log("Connected to gateway");
      this.reconnectAttempts = 0;
      this.register();
    });

    this.ws.on("message", (data: Buffer) => {
      this.handleMessage(data);
    });

    this.ws.on("close", () => {
      console.log("Disconnected from gateway");
      this.reconnect();
    });

    this.ws.on("error", (error) => {
      console.error("WebSocket error:", error);
    });
  }

  private reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      process.exit(1);
    }

    this.reconnectAttempts++;
    console.log(
      `Reconnecting in ${this.reconnectDelay}ms (attempt ${this.reconnectAttempts})`,
    );

    setTimeout(() => {
      this.connect();
    }, this.reconnectDelay);
  }

  private register() {
    const message = {
      type: "register",
      protocolVersion: 1,
      agentId: AGENT_ID,
      agentName: "Example Agent",
      capabilities: {
        tools: [
          {
            name: "file.read",
            description: "Read a file from the filesystem",
            inputSchema: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "File path to read",
                },
              },
              required: ["path"],
            },
          },
          {
            name: "shell.exec",
            description: "Execute a shell command",
            inputSchema: {
              type: "object",
              properties: {
                command: {
                  type: "string",
                  description: "Shell command to execute",
                },
              },
              required: ["command"],
            },
          },
          {
            name: "system.info",
            description: "Get system information",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
        meta: {
          os: process.platform,
          nodeVersion: process.version,
          version: "1.0.0",
        },
      },
    };

    this.send(message);
  }

  private handleMessage(data: Buffer) {
    try {
      const message = JSON.parse(data.toString());

      switch (message.type) {
        case "registered":
          console.log("Successfully registered with gateway");
          console.log("Gateway version:", message.gatewayVersion);
          break;

        case "ping":
          this.send({ type: "pong", ts: message.ts });
          break;

        case "call":
          this.handleToolCall(message);
          break;

        case "error":
          console.error("Gateway error:", message.error);
          break;

        default:
          console.warn("Unknown message type:", message.type);
      }
    } catch (error) {
      console.error("Error handling message:", error);
    }
  }

  private async handleToolCall(message: any) {
    console.log(`Tool call: ${message.name}`, message.arguments);

    try {
      const result = await this.executeTool(message.name, message.arguments);

      this.send({
        type: "call_result",
        requestId: message.requestId,
        ok: true,
        result: {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
        },
      });
    } catch (error) {
      console.error("Tool execution error:", error);

      this.send({
        type: "call_result",
        requestId: message.requestId,
        ok: false,
        error: {
          code: "TOOL_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async executeTool(name: string, args: any): Promise<string> {
    // Remove agent prefix if present
    const toolName = name.split(".").slice(-2).join(".");

    switch (toolName) {
      case "file.read":
        return this.readFile(args.path);

      case "shell.exec":
        return this.execCommand(args.command);

      case "system.info":
        return this.getSystemInfo();

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private readFile(path: string): string {
    try {
      const content = readFileSync(path, "utf-8");
      return `File: ${path}\n\n${content}`;
    } catch (error) {
      throw new Error(
        `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private execCommand(command: string): string {
    try {
      const output = execSync(command, {
        encoding: "utf-8",
        timeout: 30000,
        maxBuffer: 1024 * 1024, // 1MB
      });
      return `Command: ${command}\n\nOutput:\n${output}`;
    } catch (error) {
      throw new Error(
        `Command failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getSystemInfo(): string {
    return JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cwd: process.cwd(),
      },
      null,
      2,
    );
  }

  private send(message: any) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error("Cannot send message: WebSocket not open");
    }
  }
}

// Start agent
console.log("Starting MCP Agent...");
new MCPAgent();

// Handle shutdown gracefully
process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  process.exit(0);
});
```

## Running the Agent

### Prerequisites

```bash
npm install ws
```

### Start the Agent

```bash
# Set environment variables
export GATEWAY_URL="wss://gateway.your-domain.com/agent/ws"
export AGENT_ID="my-home-pc"
export AGENT_KEY="your-secret-key-here"

# Run
node agent.js
```

### Using with Docker

Create a `Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY agent.ts ./
RUN npm install -g tsx

CMD ["tsx", "agent.ts"]
```

Run with docker-compose:

```yaml
version: "3.8"

services:
  my-agent:
    build: .
    environment:
      - GATEWAY_URL=wss://gateway.your-domain.com/agent/ws
      - AGENT_ID=my-home-pc
      - AGENT_KEY=your-secret-key
    restart: unless-stopped
```

## Python Agent Example

```python
import asyncio
import json
import os
import websockets
from typing import Any, Dict

GATEWAY_URL = os.getenv("GATEWAY_URL", "ws://localhost:3000/agent/ws")
AGENT_ID = os.getenv("AGENT_ID", "python-agent")
AGENT_KEY = os.getenv("AGENT_KEY", "your-secret-key")

class MCPAgent:
    def __init__(self):
        self.ws = None

    async def connect(self):
        uri = f"{GATEWAY_URL}?token={AGENT_KEY}"
        async with websockets.connect(uri) as websocket:
            self.ws = websocket
            await self.register()
            await self.listen()

    async def register(self):
        message = {
            "type": "register",
            "protocolVersion": 1,
            "agentId": AGENT_ID,
            "agentName": "Python Agent",
            "capabilities": {
                "tools": [
                    {
                        "name": "python.eval",
                        "description": "Evaluate Python expression",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "expression": {"type": "string"}
                            },
                            "required": ["expression"]
                        }
                    }
                ]
            }
        }
        await self.send(message)

    async def listen(self):
        async for message in self.ws:
            await self.handle_message(json.loads(message))

    async def handle_message(self, msg: Dict[str, Any]):
        if msg["type"] == "registered":
            print("Registered successfully")
        elif msg["type"] == "ping":
            await self.send({"type": "pong", "ts": msg["ts"]})
        elif msg["type"] == "call":
            await self.handle_call(msg)

    async def handle_call(self, msg: Dict[str, Any]):
        try:
            result = self.execute_tool(msg["name"], msg["arguments"])
            await self.send({
                "type": "call_result",
                "requestId": msg["requestId"],
                "ok": True,
                "result": {
                    "content": [{"type": "text", "text": str(result)}]
                }
            })
        except Exception as e:
            await self.send({
                "type": "call_result",
                "requestId": msg["requestId"],
                "ok": False,
                "error": {"code": "TOOL_ERROR", "message": str(e)}
            })

    def execute_tool(self, name: str, args: Dict[str, Any]) -> str:
        if "eval" in name:
            return eval(args["expression"])
        raise ValueError(f"Unknown tool: {name}")

    async def send(self, msg: Dict[str, Any]):
        await self.ws.send(json.dumps(msg))

if __name__ == "__main__":
    agent = MCPAgent()
    asyncio.run(agent.connect())
```

## Best Practices

1. **Implement Reconnection Logic**: Always handle disconnections and reconnect automatically
2. **Handle Ping/Pong**: Respond to pings to maintain connection
3. **Validate Tool Arguments**: Check arguments before execution
4. **Use Timeouts**: Set reasonable timeouts for tool execution
5. **Log Everything**: Use structured logging for debugging
6. **Security**: Never expose sensitive operations without validation
7. **Error Handling**: Always catch and report errors properly
8. **Resource Limits**: Set limits on command execution time and output size

## Advanced Features

### Dynamic Tool Updates

```typescript
// Update tools without reconnecting
private updateCapabilities() {
  this.send({
    type: 'capabilities_update',
    protocolVersion: 1,
    tools: [
      // New tool list
    ],
  });
}
```

### Tool Namespacing

```typescript
// Pre-namespace tools to avoid conflicts
tools: [
  {
    name: "mypc.file.read", // Already namespaced
    description: "...",
  },
];
```

### Health Monitoring

```typescript
// Periodic health check
setInterval(() => {
  if (this.ws?.readyState !== WebSocket.OPEN) {
    console.error("Connection lost, reconnecting...");
    this.reconnect();
  }
}, 5000);
```

## Troubleshooting

### Connection Rejected

- Verify agent key in gateway's `AGENT_KEYS_JSON`
- Check agentId matches configuration
- Ensure WebSocket URL is correct

### Tool Not Found

- Check tool name matches exactly (case-sensitive)
- Verify capabilities were sent in register message
- Check gateway logs for registration errors

### Timeouts

- Reduce tool execution time
- Increase `AGENT_CALL_TIMEOUT_MS` in gateway
- Add progress updates for long-running tools
