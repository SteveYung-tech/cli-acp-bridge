import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { createAgentServer } from "./acp/server.js";
import { AtomCodeAdapter } from "./adapters/atomcode/index.js";
import { AgyAdapter } from "./adapters/agy/index.js";
import type { AgentAdapter } from "./adapters/base.js";

export function getAdapter(type?: string): AgentAdapter {
  const chosen = type || process.env.ACP_ADAPTER || process.argv.find((a) => a.startsWith("--adapter="))?.split("=")[1] || "atomcode";
  if (chosen === "agy" || chosen === "antigravity") {
    return new AgyAdapter();
  }
  return new AtomCodeAdapter();
}

export async function main(adapterType?: string) {
  const adapter = getAdapter(adapterType);
  const agentServer = createAgentServer(adapter);

  // Create ACP newline-delimited JSON-RPC stream over stdio
  const input = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  // Connect agent to stdio stream
  const connection = agentServer.connect(stream);
  try {
    await connection.closed;
  } finally {
    await agentServer.dispose();
  }
}

// Auto-start when executed directly
if (process.argv[1] && (process.argv[1].endsWith("index.js") || process.argv[1].endsWith("index.ts"))) {
  main().catch((err) => {
    console.error("Fatal error in ACP server:", err);
    process.exitCode = 1;
  });
}
