import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomCodeAdapter } from "../src/adapters/atomcode/index.js";
import type { ExecuteTurnOptions } from "../src/adapters/base.js";
import type { SessionState } from "../src/session/manager.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "fake-atomcode.mjs");

function session(id: string): SessionState {
  return {
    id,
    cwd: process.cwd(),
    turnCount: 0,
    metrics: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalThinkingTokens: 0,
      totalCachedTokens: 0,
      totalToolCalls: 0,
      lastPromptTokens: 0,
    },
    configOptions: {},
    activeAbortController: null,
    currentTurnPromise: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function turn(sessionId: string, prompt: string, extra: Partial<ExecuteTurnOptions> = {}): ExecuteTurnOptions {
  return { sessionId, cwd: process.cwd(), prompt, ...extra };
}

async function readRequests(logPath: string, url: string): Promise<any[]> {
  const content = await readFile(logPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    .filter((record) => record.event === "request" && record.url === url);
}

async function waitForRequests(logPath: string, url: string, count: number): Promise<any[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const requests = await readRequests(logPath, url);
      if (requests.length >= count) return requests;
    } catch {
      // The daemon has not created the log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function createFixtureAdapter(logPath: string): AtomCodeAdapter {
  return new AtomCodeAdapter({
    command: { command: process.execPath, argsPrefix: [fixturePath] },
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    startupTimeoutMs: 1_000,
  });
}

test("AtomCode reuses one daemon across ACP sessions and turns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-adapter-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const first = session("acp-one");
  const second = session("acp-two");
  try {
    await adapter.start();
    adapter.createSession(first);
    adapter.createSession(second);
    await adapter.executeTurn(turn(first.id, "one"));
    await adapter.executeTurn(turn(first.id, "two"));
    await adapter.executeTurn(turn(second.id, "three"));
    const content = await readFile(logPath, "utf8");
    const records = content.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.event === "startup").length, 1);
    assert.equal(records.filter((record) => record.url === "/sessions").length, 2);
    assert.equal(records.filter((record) => record.url === "/chat").length, 3);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode maps text, reasoning, tools, tokens, and provider without batching", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-events-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const state = session("acp-one");
  state.model = "provider-x";
  const calls: string[] = [];
  try {
    adapter.createSession(state);
    await adapter.executeTurn(turn(state.id, "one", {
      model: state.model,
      onChunk: (text) => calls.push(`text:${text}`),
      onThought: (text) => calls.push(`thought:${text}`),
      onToolStart: (id, name, input) => calls.push(`start:${id}:${name}:${JSON.stringify(input)}`),
      onToolEnd: (id, output) => calls.push(`end:${id}:${output}`),
      onMetrics: (metrics) => calls.push(`metrics:${JSON.stringify(metrics)}`),
    }));
    assert.deepEqual(calls, [
      "text:hello",
      "thought:thinking",
      "start:tool-1:fake_tool:{}",
      "end:tool-1:fake output",
      "text: world",
      'metrics:{"inputTokens":3,"outputTokens":2}',
      'metrics:{"toolCalls":1}',
    ]);
    const chat = (await readRequests(logPath, "/chat"))[0];
    assert.equal(JSON.parse(chat.body).provider, "provider-x");
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode leaves provider selection to daemon config by default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-default-provider-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const state = session("acp-default");
  try {
    const modelOption = adapter.getAvailableConfigOptions(state).find((option) => option.id === "model");
    assert.equal(modelOption?.currentValue, "default");
    state.model = String(modelOption?.currentValue);
    adapter.createSession(state);
    await adapter.executeTurn(turn(state.id, "one", { model: state.model }));
    const chat = (await readRequests(logPath, "/chat"))[0];
    assert.equal("provider" in JSON.parse(chat.body), false);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode cancellation uses request id before assignment and native session id afterward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-cancel-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const before = session("acp-before");
  const after = session("acp-after");
  try {
    adapter.createSession(before);
    adapter.createSession(after);

    const beforeTurn = adapter.executeTurn(turn(before.id, "slow-assign"));
    await waitForRequests(logPath, "/chat", 1);
    await adapter.cancelTurn(before.id);
    assert.equal((await beforeTurn).cancelled, true);

    let firstText!: () => void;
    const textSeen = new Promise<void>((resolve) => { firstText = resolve; });
    const afterTurn = adapter.executeTurn(turn(after.id, "slow-done", { onChunk: () => firstText() }));
    await textSeen;
    await adapter.cancelTurn(after.id);
    assert.equal((await afterTurn).cancelled, true);

    const stops = await readRequests(logPath, "/chat/stop");
    const firstTarget = JSON.parse(stops[0].body).session_id;
    const secondTarget = JSON.parse(stops[1].body).session_id;
    assert.match(firstTarget, /^[0-9a-f-]{36}$/i);
    assert.equal(secondTarget, "fake-session-2");
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode rejects error events and treats stopped as cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-terminal-"));
  const adapter = createFixtureAdapter(join(directory, "backend.log"));
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    await assert.rejects(adapter.executeTurn(turn(state.id, "error")), /fake chat error/);
    assert.equal((await adapter.executeTurn(turn(state.id, "stopped"))).cancelled, true);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode rejects a terminal event that has no assistant output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-empty-terminal-"));
  const adapter = createFixtureAdapter(join(directory, "backend.log"));
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    await assert.rejects(
      adapter.executeTurn(turn(state.id, "empty-done")),
      /without assistant output.*rate_limited/i,
    );
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode rejects overlapping turns even while native session preparation is pending", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-overlap-"));
  const adapter = createFixtureAdapter(join(directory, "backend.log"));
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    const first = adapter.executeTurn(turn(state.id, "slow-done"));
    await assert.rejects(adapter.executeTurn(turn(state.id, "second")), /already active/i);
    await first;
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode close prevents a pending prepared turn from starting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-close-race-"));
  const adapter = createFixtureAdapter(join(directory, "backend.log"));
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    const pending = adapter.executeTurn(turn(state.id, "one"));
    await adapter.closeSession(state.id);
    await assert.rejects(pending, /closed/i);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
