import assert from "node:assert/strict";
import test from "node:test";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../src/adapters/base.js";
import { AgyAdapter } from "../src/adapters/agy/index.js";
import { AtomCodeAdapter } from "../src/adapters/atomcode/index.js";
import { SessionManager, type SessionState } from "../src/session/manager.js";

const recordedSessionIds: string[] = [];

function createRecordingAdapter(): AgentAdapter {
  const result: TurnResult = { exitCode: 0, stdout: "", stderr: "", cancelled: false };
  return {
    id: "recording",
    name: "Recording",
    defaultBinaryName: "recording",
    binaryEnvVar: "RECORDING_PATH",
    async start() {},
    createSession(session: SessionState) {
      recordedSessionIds.push(session.id);
    },
    async updateSession(session: SessionState) {
      recordedSessionIds.push(session.id);
    },
    async cancelTurn(sessionId: string) {
      recordedSessionIds.push(sessionId);
    },
    async closeSession(sessionId: string) {
      recordedSessionIds.push(sessionId);
    },
    async dispose() {},
    resolveBinaryPath() {
      return "recording";
    },
    getAvailableConfigOptions() {
      return [];
    },
    getAvailableCommands() {
      return [];
    },
    async executeTurn(_options: ExecuteTurnOptions) {
      return result;
    },
  };
}

test("adapter lifecycle is session keyed", async () => {
  recordedSessionIds.length = 0;
  const adapter: AgentAdapter = createRecordingAdapter();
  const session = new SessionManager().createSession(process.cwd());

  await adapter.start();
  adapter.createSession(session);
  await adapter.updateSession(session);
  await adapter.cancelTurn(session.id);
  await adapter.closeSession(session.id);
  await adapter.dispose();

  assert.deepEqual(recordedSessionIds, [session.id, session.id, session.id, session.id]);
});

test("built-in adapters expose idempotent no-op lifecycle methods", async () => {
  const session = new SessionManager().createSession(process.cwd());

  for (const adapter of [new AgyAdapter(), new AtomCodeAdapter()]) {
    await adapter.start();
    await adapter.start();
    adapter.createSession(session);
    adapter.createSession(session);
    await adapter.updateSession(session);
    await adapter.updateSession(session);
    await adapter.cancelTurn(session.id);
    await adapter.cancelTurn(session.id);
    await adapter.closeSession(session.id);
    await adapter.closeSession(session.id);
    await adapter.dispose();
    await adapter.dispose();
  }
});
