// MCP JSON-RPC method dispatch (transport-agnostic). The HTTP framing lives in server.ts.

import { SERVER_INSTRUCTIONS } from "./agent-instructions";
import { type BridgeContext, executeTool } from "./executor";
import { TOOL_DEFS } from "./mcp-tools";
import { loadMemories } from "./memory";

const PROTOCOL_VERSION = "2025-06-18";

export interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/** Returns a JSON-RPC response object, or null for notifications (no reply). */
export async function handleRpc(msg: RpcMessage, ctx: BridgeContext): Promise<object | null> {
  const id = msg.id ?? null;
  const hasId = msg.id !== undefined && msg.id !== null;
  const result = (r: unknown) => ({ jsonrpc: "2.0", id, result: r });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (msg.method) {
    case "initialize":
      return result({
        protocolVersion: (msg.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cupcat", version: "0.1.0" },
        instructions: SERVER_INSTRUCTIONS + (await loadMemories()),
      });
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return null;
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOL_DEFS });
    case "tools/call": {
      if (!hasId) return null;
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const out = await executeTool(ctx, name, args, "agent");
      return result({ content: out.content, isError: out.isError });
    }
    case "resources/list":
      return result({ resources: [] });
    case "resources/templates/list":
      return result({ resourceTemplates: [] });
    case "prompts/list":
      return result({ prompts: [] });
    default:
      return hasId ? error(-32601, `Method not found: ${msg.method}`) : null;
  }
}
