#!/usr/bin/env node
// Deterministic fake AtomCode daemon for tests.
//
// Usage: fake-atomcode.mjs daemon --port <port>
//
// Mimics the atomcode-daemon HTTP + SSE surface the AtomCode adapter drives:
//   GET  /health       readiness probe
//   POST /sessions     create a native session
//   POST /chat         SSE stream: runtime_info, session_assigned, reasoning,
//                      split text deltas, tool_start, tool_result, tokens, done
//   POST /chat/stop    cancel an in-progress turn
//   POST /shutdown     graceful shutdown
//
// When FAKE_BACKEND_LOG is set, appends one JSON record per request so tests
// can assert on daemon lifecycle and traffic without a real backend.

import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

const logPath = process.env.FAKE_BACKEND_LOG;

function log(record) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(record) + "\n");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const subcommand = args[0];
  let port = 13456;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port") {
      port = Number(args[++i]);
    } else if (args[i].startsWith("--port=")) {
      port = Number(args[i].slice("--port=".length));
    }
  }
  return { subcommand, port };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
  });
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamChatFrames(res) {
  sse(res, {
    type: "runtime_info",
    provider: "fake-provider",
    model: "fake-model",
  });
  sse(res, {
    type: "session_assigned",
    session_id: "fake-session",
  });
  sse(res, { type: "text", content: "hello" });
  sse(res, { type: "reasoning", content: "thinking" });
  sse(res, {
    type: "tool_start",
    id: "tool-1",
    name: "fake_tool",
    arguments: "{}",
  });
  sse(res, {
    type: "tool_result",
    id: "tool-1",
    name: "fake_tool",
    output: "fake output",
    success: true,
    duration_ms: 1,
  });
  sse(res, { type: "text", content: " world" });
  sse(res, {
    type: "tokens",
    prompt: 3,
    completion: 2,
    total: 5,
  });
  sse(res, {
    type: "done",
    session_id: "fake-session",
    stop_reason: "end_turn",
    tokens: 5,
    tool_calls: 1,
  });
}

function main() {
  const { subcommand, port } = parseArgs(process.argv);
  if (subcommand !== "daemon") {
    process.stderr.write(`fake-atomcode: expected 'daemon' subcommand, got '${subcommand}'\n`);
    process.exit(2);
  }

  const server = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    let body = "";
    try {
      body = await readBody(req);
    } catch {
      body = "";
    }
    log({ event: "request", backend: "atomcode", method, url, body });

    if (method === "GET" && url === "/health") {
      writeJson(res, 200, { status: "ok" });
      return;
    }

    if (method === "POST" && url === "/sessions") {
      writeJson(res, 201, {
        id: "fake-session",
        name: "fake-session",
        working_dir: "fixture",
        project_hash: "fake-project",
        created_at: 1_723_939_200,
      });
      return;
    }

    if (method === "POST" && url === "/chat") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      streamChatFrames(res);
      res.end();
      return;
    }

    if (method === "POST" && url === "/chat/stop") {
      writeJson(res, 200, { status: "stopped" });
      return;
    }

    if (method === "POST" && url === "/shutdown") {
      writeJson(res, 200, { status: "shutting_down" });
      server.close(() => process.exit(0));
      return;
    }

    writeJson(res, 404, { error: "not found", method, url });
  });

  server.listen(port, "127.0.0.1", () => {
    log({ event: "startup", backend: "atomcode", port });
    process.stdout.write(`fake-atomcode daemon listening on 127.0.0.1:${port}\n`);
  });
}

main();
