#!/usr/bin/env node
// Deterministic fake agy (Antigravity) backend for tests.
//
// Speaks the NDJSON stream protocol used by the AGY adapter:
//   - emits one init event after startup, then stays alive
//   - for every JSON user message on stdin, emits step_update deltas and a
//     terminal result event, all in a fixed deterministic order
//
// When FAKE_BACKEND_LOG is set, appends one JSON record per startup or per
// received prompt so tests can assert on backend lifecycle and traffic.

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

const logPath = process.env.FAKE_BACKEND_LOG;

function log(record) {
  if (!logPath) return;
  appendFileSync(logPath, JSON.stringify(record) + "\n");
}

function emit(event) {
  stdout.write(JSON.stringify(event) + "\n");
}

// Startup: log it, emit the init event, then keep the process alive.
log({ event: "startup", backend: "agy" });
emit({
  event: "init",
  conversation_id: "fake-conversation",
  init: { cwd: "fixture", tools: [] },
});

const rl = createInterface({ input: stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    message = { text: trimmed };
  }
  log({ event: "prompt", backend: "agy", message });
  emit({ event: "step_update", step_update: { step_type: "thought", text_delta: "thinking" } });
  emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "hello" } });
  emit({ event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "ACTIVE", tool_info: { tool_name: "fixture", parameters: {} } } });
  emit({ event: "step_update", step_update: { step_type: "tool", step_index: 1, state: "DONE", tool_info: { tool_name: "fixture", output: "ok" } } });
  emit({ event: "step_update", step_update: { step_type: "agent_response", text_delta: " world" } });
  emit({
    event: "result",
    result: {
      conversation_id: "fake-conversation",
      status: "SUCCESS",
      response: "hello world",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        thinking_tokens: 1,
        cache_read_tokens: 0,
      },
    },
  });
});
