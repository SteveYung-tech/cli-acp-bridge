import assert from "node:assert/strict";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../src/adapters/base.js";
import { createAgentServer } from "../src/acp/server.js";
import type { SessionState } from "../src/session/manager.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("ACP server owns adapter readiness, session defaults, cancellation, and cleanup", async () => {
  const calls: string[] = [];
  const startGate = deferred<void>();
  const turnGate = deferred<TurnResult>();
  let createdSession: SessionState | undefined;
  let executed = false;

  const adapter: AgentAdapter = {
    id: "recording",
    name: "Recording",
    defaultBinaryName: "recording",
    binaryEnvVar: "RECORDING_PATH",
    start() {
      calls.push("start");
      return startGate.promise;
    },
    createSession(session) {
      createdSession = session;
      calls.push(`create:${session.model}:${session.mode}:${session.provider}`);
    },
    async updateSession(session) {
      calls.push(`update:${session.model}:${session.mode}:${session.provider}`);
    },
    async cancelTurn(sessionId) {
      calls.push(`cancel:${sessionId}`);
      turnGate.resolve({ exitCode: null, stdout: "", stderr: "", cancelled: true });
    },
    async closeSession(sessionId) {
      calls.push(`close:${sessionId}`);
    },
    async dispose() {
      calls.push("dispose");
    },
    resolveBinaryPath() {
      return "recording";
    },
    getAvailableConfigOptions() {
      return [
        { id: "model", name: "Model", type: "select", currentValue: "model-default", options: [] },
        { id: "mode", name: "Mode", type: "select", currentValue: "mode-default", options: [] },
        { id: "provider", name: "Provider", type: "select", currentValue: "provider-default", options: [] },
      ];
    },
    getAvailableCommands() {
      return [];
    },
    async executeTurn(options: ExecuteTurnOptions) {
      executed = true;
      calls.push(`execute:${options.sessionId}:${options.model}:${options.mode}:${options.provider}`);
      return turnGate.promise;
    },
  };

  const server = createAgentServer(adapter);
  assert.deepEqual(calls, ["start"]);
  const connection = acp.client({ name: "lifecycle-test" }).connect(server);

  try {
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    assert.deepEqual(initialized.agentCapabilities.sessionCapabilities, { close: {}, delete: {} });

    const response = await connection.agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    const sessionId = response.sessionId;
    assert.equal(createdSession?.model, "model-default");
    assert.equal(createdSession?.mode, "mode-default");
    assert.equal(createdSession?.provider, "provider-default");

    await connection.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: "model",
      value: "model-next",
    });
    await connection.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: "mode-next" });

    const prompt = connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: "text", text: "hello" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executed, false, "prompt must wait until the adapter is ready");

    startGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(executed, true);

    await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    assert.equal((await prompt).stopReason, "cancelled");
    await connection.agent.request(acp.methods.agent.session.close, { sessionId });
    await connection.agent.request(acp.methods.agent.session.delete, { sessionId });

    assert.equal(calls.filter((call) => call === "start").length, 1);
    assert.ok(calls.includes(`execute:${sessionId}:model-next:mode-next:provider-default`));
    assert.ok(calls.includes(`close:${sessionId}`));
  } finally {
    connection.close();
    await connection.closed;
    await server.dispose();
  }

  assert.equal(calls.at(-1), "dispose");
});

test("server disposal closes every remaining session before the adapter", async () => {
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    id: "recording",
    name: "Recording",
    defaultBinaryName: "recording",
    binaryEnvVar: "RECORDING_PATH",
    async start() { calls.push("start"); },
    createSession(session) { calls.push(`create:${session.id}`); },
    async updateSession() {},
    async cancelTurn(sessionId) { calls.push(`cancel:${sessionId}`); },
    async closeSession(sessionId) { calls.push(`close:${sessionId}`); },
    async dispose() { calls.push("dispose"); },
    resolveBinaryPath() { return "recording"; },
    getAvailableConfigOptions() { return []; },
    getAvailableCommands() { return []; },
    async executeTurn() { return { exitCode: 0, stdout: "", stderr: "", cancelled: false }; },
  };
  const server = createAgentServer(adapter);
  const connection = acp.client({ name: "dispose-test" }).connect(server);
  try {
    const first = await connection.agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    const second = await connection.agent.request(acp.methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] });
    await server.dispose();
    assert.deepEqual(calls.slice(-5), [
      `cancel:${first.sessionId}`,
      `cancel:${second.sessionId}`,
      `close:${first.sessionId}`,
      `close:${second.sessionId}`,
      "dispose",
    ]);
    await server.dispose();
    assert.equal(calls.filter((call) => call === "dispose").length, 1);
  } finally {
    connection.close();
    await connection.closed;
  }
});

test("ACP tool updates preserve semantic kinds instead of rendering everything as execute", async () => {
  const observed: Array<{ title: string; kind: string }> = [];
  const adapter: AgentAdapter = {
    id: "tool-kinds",
    name: "Tool Kinds",
    defaultBinaryName: "tool-kinds",
    binaryEnvVar: "TOOL_KINDS_PATH",
    async start() {},
    createSession() {},
    async updateSession() {},
    async cancelTurn() {},
    async closeSession() {},
    async dispose() {},
    resolveBinaryPath() { return "tool-kinds"; },
    getAvailableConfigOptions() { return []; },
    getAvailableCommands() { return []; },
    async executeTurn(options) {
      await options.onToolStart?.("search", "Tool", { Query: "needle", SearchPath: process.cwd() });
      await options.onToolStart?.("read", "Tool", { AbsolutePath: "README.md" });
      await options.onToolStart?.("edit", "Tool", { TargetFile: "README.md" });
      await options.onToolStart?.("task", "Tool", { Action: "status", TaskId: "task-1" });
      return { exitCode: 0, stdout: "", stderr: "", cancelled: false };
    },
  };
  const server = createAgentServer(adapter);
  const client = acp.client({ name: "tool-kind-test" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      if (ctx.params.update.sessionUpdate === "tool_call") {
        observed.push({ title: ctx.params.update.title, kind: ctx.params.update.kind });
      }
    });
  const connection = client.connect(server);
  try {
    const session = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "inspect" }],
    });
    assert.deepEqual(observed, [
      { title: "Search", kind: "search" },
      { title: "Read", kind: "read" },
      { title: "Edit", kind: "edit" },
      { title: "Task", kind: "other" },
    ]);
  } finally {
    connection.close();
    await connection.closed;
    await server.dispose();
  }
});

test("ACP converts backend turn failures into an agent message and TurnComplete", async () => {
  const messages: string[] = [];
  const adapter: AgentAdapter = {
    id: "failing",
    name: "Failing Backend",
    defaultBinaryName: "failing",
    binaryEnvVar: "FAILING_PATH",
    async start() {},
    createSession() {},
    async updateSession() {},
    async cancelTurn() {},
    async closeSession() {},
    async dispose() {},
    resolveBinaryPath() { return "failing"; },
    getAvailableConfigOptions() { return []; },
    getAvailableCommands() { return []; },
    async executeTurn() {
      throw new Error("provider rate limited\u001b[31m");
    },
  };
  const server = createAgentServer(adapter);
  const client = acp.client({ name: "failure-test" })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        messages.push(update.content.text);
      }
    });
  const connection = client.connect(server);
  try {
    const session = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const result = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "work" }],
    });
    assert.equal(result.stopReason, "end_turn");
    assert.deepEqual(messages, ["Failing Backend failed: provider rate limited"]);
  } finally {
    connection.close();
    await connection.closed;
    await server.dispose();
  }
});
