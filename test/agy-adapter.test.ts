import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgyAdapter } from "../src/adapters/agy/index.js";
import type { ExecuteTurnOptions } from "../src/adapters/base.js";
import type { SessionState } from "../src/session/manager.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "fake-agy.mjs");

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

function turn(sessionId: string, prompt: string, signal?: AbortSignal): ExecuteTurnOptions {
  return { sessionId, cwd: process.cwd(), prompt, signal };
}

async function readRecords(logPath: string, event: string): Promise<any[]> {
  const content = await readFile(logPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.event === event);
}

function createFixtureAdapter(logPath: string): AgyAdapter {
  return new AgyAdapter({
    command: { command: process.execPath, argsPrefix: [fixturePath] },
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    startupTimeoutMs: 1_000,
  });
}

test("AGY creates one isolated persistent worker per ACP session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-adapter-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const first = session("acp-one");
  const second = session("acp-two");
  try {
    adapter.createSession(first);
    adapter.createSession(second);
    await Promise.all([
      adapter.executeTurn(turn(first.id, "one")),
      adapter.executeTurn(turn(second.id, "two")),
    ]);
    await adapter.executeTurn(turn(first.id, "three"));
    assert.equal((await readRecords(logPath, "startup")).length, 2);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY replaces an unused worker when configuration changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-adapter-config-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    await new Promise((resolve) => setTimeout(resolve, 100));
    state.model = "Gemini 3.1 Pro (High)";
    await adapter.updateSession(state);
    await adapter.executeTurn(turn(state.id, "one"));
    const starts = await readRecords(logPath, "startup");
    assert.equal(starts.length, 2);
    assert.equal(starts.at(-1)?.model, "Gemini 3.1 Pro (High)");
    assert.equal(starts.at(-1)?.mode, "accept-edits");
    assert.equal(starts.at(-1)?.conversation_id, undefined);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY cancellation and close affect only the target ACP session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-adapter-scope-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const first = session("acp-one");
  const second = session("acp-two");
  try {
    adapter.createSession(first);
    adapter.createSession(second);
    const blocked = adapter.executeTurn(turn(first.id, "block"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await adapter.cancelTurn(first.id);
    assert.equal((await blocked).cancelled, true);
    await adapter.executeTurn(turn(first.id, "after-cancel"));
    const chunks: string[] = [];
    await adapter.executeTurn({ ...turn(second.id, "ok"), onChunk: (text) => chunks.push(text) });
    assert.deepEqual(chunks, ["hello", " world"]);
    await adapter.closeSession(first.id);
    await adapter.executeTurn(turn(second.id, "still-alive"));
    await assert.rejects(adapter.executeTurn(turn(first.id, "closed")), /unknown|closed/i);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY restarts a used worker with its conversation id after configuration changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-adapter-resume-"));
  const logPath = join(directory, "backend.log");
  const adapter = createFixtureAdapter(logPath);
  const state = session("acp-one");
  try {
    adapter.createSession(state);
    await adapter.executeTurn(turn(state.id, "one"));
    state.mode = "plan";
    await adapter.updateSession(state);
    const starts = await readRecords(logPath, "startup");
    assert.equal(starts.length, 2);
    assert.equal(starts.at(-1)?.conversation_id, "fake-conversation");
    assert.equal(starts.at(-1)?.mode, "plan");
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
