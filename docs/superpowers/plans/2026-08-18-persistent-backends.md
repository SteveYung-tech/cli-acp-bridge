# Persistent ACP Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-turn AtomCode and AGY CLI launches with persistent, session-safe backend transports that reduce time to first output.

**Architecture:** One ACP process owns one private AtomCode HTTP/SSE daemon shared by its sessions, while each AGY ACP session owns one long-running NDJSON worker. The ACP session ID is the routing key, backend events are serialized before notification, and failed turns are never replayed automatically.

**Tech Stack:** TypeScript 7, Node.js 22 built-in `fetch`, streams, child processes, `node:test`, `tsx`, Agent Client Protocol SDK 1.3.

## Global Constraints

- Preserve the `atomcode-acp` and `agy-acp` executable names and distribution manifests.
- Preserve `ATOMCODE_PATH` and `AGY_PATH` overrides.
- Bind the adapter-owned AtomCode daemon only to `127.0.0.1` on a private dynamic port.
- Do not silently fall back to one-shot CLI execution.
- Do not automatically replay a failed prompt because backend tools may already have changed files.
- Never write diagnostics to stdout; stdout is reserved for ACP NDJSON traffic.
- Forward non-empty backend deltas immediately without a batching timer.
- Use no new runtime dependency; rely on Node.js built-ins.
- Every production behavior must be preceded by a test that fails for the expected reason.

## File Structure

- `src/runtime/process-command.ts`: executable plus argument-prefix test seam and child-process termination helper.
- `src/runtime/timing.ts`: opt-in monotonic `ACP_TIMING=1` stderr records.
- `src/adapters/agy/worker.ts`: one persistent AGY NDJSON process and one-turn-at-a-time state machine.
- `src/adapters/agy/index.ts`: ACP-session-to-AGY-worker ownership and adapter event mapping.
- `src/adapters/atomcode/sse.ts`: incremental SSE framing independent of HTTP and adapter logic.
- `src/adapters/atomcode/daemon.ts`: private daemon process lifecycle and typed HTTP operations.
- `src/adapters/atomcode/index.ts`: ACP-session-to-native-session mapping and SSE-to-adapter event mapping.
- `src/adapters/base.ts`: lifecycle contract shared by the server and adapters.
- `src/acp/server.ts`: session lifecycle, defaults, cancellation, and turn dispatch.
- `src/index.ts`: ACP disconnect cleanup.
- `test/fixtures/fake-agy.mjs`: deterministic persistent NDJSON executable.
- `test/fixtures/fake-atomcode.mjs`: deterministic AtomCode daemon executable with HTTP/SSE endpoints.
- `test/*.test.ts`: unit and adapter integration tests with no live model calls.

---

### Task 1: Deterministic Test Harness And Process Boundary

**Files:**
- Create: `src/runtime/process-command.ts`
- Create: `test/fixtures/fake-agy.mjs`
- Create: `test/fixtures/fake-atomcode.mjs`
- Create: `test/process-command.test.ts`
- Modify: `package.json:12-19`

**Interfaces:**
- Produces: `ProcessCommand { command: string; argsPrefix: string[] }`.
- Produces: `spawnCommand(spec, args, options): ChildProcessWithoutNullStreams`.
- Produces: `terminateProcess(child, graceMs?): Promise<void>`.
- Fake backends consume `FAKE_BACKEND_LOG` and append one JSON record per startup or received prompt.

- [ ] **Step 1: Add the failing process-boundary test**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { spawnCommand, terminateProcess } from "../src/runtime/process-command.js";

test("spawnCommand prepends fixture arguments and terminates idempotently", async () => {
  const child = spawnCommand(
    { command: process.execPath, argsPrefix: ["-e", "process.stdin.resume()"] },
    [],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  assert.equal(child.exitCode, null);
  await terminateProcess(child, 50);
  await terminateProcess(child, 50);
  assert.notEqual(child.exitCode, null);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx tsx --test test/process-command.test.ts`

Expected: FAIL because `src/runtime/process-command.ts` does not exist.

- [ ] **Step 3: Implement the process boundary**

```ts
export interface ProcessCommand {
  command: string;
  argsPrefix: string[];
}

export function spawnCommand(
  spec: ProcessCommand,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessWithoutNullStreams {
  return spawn(spec.command, [...spec.argsPrefix, ...args], options);
}

function forceTerminateProcessTree(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return;
  }
  child.kill("SIGTERM");
}

export async function terminateProcess(
  child: ChildProcessWithoutNullStreams,
  graceMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.stdin.end();
  const timer = setTimeout(() => forceTerminateProcessTree(child), graceMs);
  await exited;
  clearTimeout(timer);
}
```

`forceTerminateProcessTree()` uses `taskkill /pid <pid> /t /f` on Windows and
`SIGTERM` elsewhere. It is only the post-grace fallback; normal cleanup first
closes stdin or calls the backend shutdown endpoint.

- [ ] **Step 4: Add deterministic fake executables**

`fake-agy.mjs` must emit this line once after startup and then remain alive:

```json
{"event":"init","conversation_id":"fake-conversation","init":{"cwd":"fixture","tools":[]}}
```

For every stdin user message it must emit, in order:

```json
{"event":"step_update","step_update":{"step_type":"thought","text_delta":"thinking"}}
{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"hello"}}
{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":" world"}}
{"event":"result","result":{"conversation_id":"fake-conversation","status":"SUCCESS","response":"hello world","usage":{"input_tokens":3,"output_tokens":2,"thinking_tokens":1,"cache_read_tokens":0}}}
```

`fake-atomcode.mjs` must recognize the `daemon` subcommand, read `--port`, expose `GET /health`, `POST /sessions`, `POST /chat`, `POST /chat/stop`, and `POST /shutdown`, and append every request to `FAKE_BACKEND_LOG`. Its `/chat` response must use `text/event-stream` and emit `runtime_info`, `session_assigned`, split `text`, `reasoning`, `tool_start`, `tool_result`, `tokens`, and `done` frames.

- [ ] **Step 5: Make unit tests the default non-metered suite**

Set these scripts exactly:

```json
{
  "test": "tsx --test test/*.test.ts",
  "test:live:atomcode": "tsx test/test-client.ts",
  "test:live:agy": "tsx test/test-agy.ts",
  "test:parser": "tsx test/test-parser.ts"
}
```

- [ ] **Step 6: Verify GREEN**

Run: `npm test`

Expected: PASS with no live model or external network request.

- [ ] **Step 7: Commit**

```powershell
git add package.json src/runtime/process-command.ts test/fixtures test/process-command.test.ts
git commit -m "test: add persistent backend fixtures"
```

---

### Task 2: Adapter Lifecycle And Timing Contract

**Files:**
- Create: `src/runtime/timing.ts`
- Create: `test/timing.test.ts`
- Create: `test/adapter-lifecycle.test.ts`
- Modify: `src/adapters/base.ts:4-42`
- Modify: `src/adapters/agy/index.ts:10-396`
- Modify: `src/adapters/atomcode/index.ts:10-308`

**Interfaces:**
- Consumes: `ProcessCommand` and `terminateProcess` from Task 1.
- Produces: lifecycle methods `start`, `createSession`, `updateSession`, `cancelTurn`, `closeSession`, and `dispose` on `AgentAdapter`.
- Produces: `ExecuteTurnOptions.sessionId: string`.
- Produces: `TimingTrace` with `mark(name): void` and `child(name): TimingTrace`.

- [ ] **Step 1: Write failing lifecycle and timing tests**

```ts
test("timing diagnostics are silent unless ACP_TIMING is enabled", () => {
  const writes: string[] = [];
  const trace = new TimingTrace("agy", "session-1", {}, (line) => writes.push(line));
  trace.mark("prompt_received");
  assert.deepEqual(writes, []);
});

test("adapter lifecycle is session keyed", async () => {
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
```

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --test test/timing.test.ts test/adapter-lifecycle.test.ts`

Expected: FAIL because `TimingTrace` and lifecycle members are missing.

- [ ] **Step 3: Add the lifecycle contract**

```ts
export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultBinaryName: string;
  readonly binaryEnvVar: string;
  start(): Promise<void>;
  createSession(session: SessionState): void;
  updateSession(session: SessionState): Promise<void>;
  cancelTurn(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
  resolveBinaryPath(): string;
  getAvailableConfigOptions(session: SessionState): acp.SessionConfigOption[];
  getAvailableCommands(session: SessionState): acp.AvailableCommand[];
  executeTurn(options: ExecuteTurnOptions): Promise<TurnResult>;
}
```

Add `sessionId: string` to `ExecuteTurnOptions`. Give both existing adapters temporary idempotent no-op lifecycle methods so the repository remains buildable until their persistent implementations land.

- [ ] **Step 4: Implement opt-in monotonic timing**

`TimingTrace` must use `performance.now()`, include adapter/session labels, and default to `process.stderr.write`. Enable it only when `env.ACP_TIMING === "1"`.

- [ ] **Step 5: Run tests and build**

Run: `npm test`

Run: `npm run build`

Expected: both PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/base.ts src/adapters/agy/index.ts src/adapters/atomcode/index.ts src/runtime/timing.ts test/timing.test.ts test/adapter-lifecycle.test.ts
git commit -m "refactor: define adapter runtime lifecycle"
```

---

### Task 3: Persistent AGY Worker

**Files:**
- Create: `src/adapters/agy/worker.ts`
- Create: `test/agy-worker.test.ts`

**Interfaces:**
- Consumes: `ProcessCommand`, `spawnCommand`, `terminateProcess`, and `TimingTrace`.
- Produces: `AgyWorkerOptions { command, cwd, model?, mode?, conversationId?, env?, startupTimeoutMs? }`.
- Produces: `AgyWorker.start(): Promise<void>`.
- Produces: `AgyWorker.runTurn(prompt, callbacks, signal?): Promise<TurnResult>`.
- Produces: `AgyWorker.cancel(): Promise<void>` and `AgyWorker.dispose(): Promise<void>`.
- Produces readonly `conversationId`, `used`, `model`, and `mode` state.

- [ ] **Step 1: Write the failing persistent-worker tests**

```ts
test("one AGY worker handles two turns without restarting", async () => {
  const worker = createFixtureWorker(logPath);
  await worker.start();
  const first: string[] = [];
  const second: string[] = [];
  await worker.runTurn("one", { onChunk: (text) => first.push(text) });
  await worker.runTurn("two", { onChunk: (text) => second.push(text) });
  assert.equal(await countLogRecords(logPath, "startup"), 1);
  assert.deepEqual(first, ["hello", " world"]);
  assert.deepEqual(second, ["hello", " world"]);
  await worker.dispose();
});

test("AGY rejects overlapping turns on one worker", async () => {
  const worker = createFixtureWorker(logPath);
  await worker.start();
  const active = worker.runTurn("one", {});
  await assert.rejects(worker.runTurn("two", {}), /already active/);
  await active;
  await worker.dispose();
});
```

Also cover init timeout, malformed NDJSON, error result, unexpected exit, callback ordering, abort, and idempotent dispose.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --test test/agy-worker.test.ts`

Expected: FAIL because `AgyWorker` does not exist.

- [ ] **Step 3: Implement AGY launch and readiness**

Construct arguments in this order:

```ts
const args = [
  "-p", "",
  "--input-format", "stream-json",
  "--output-format", "stream-json",
  "--dangerously-skip-permissions",
];
if (options.conversationId) args.push("--conversation", options.conversationId);
if (options.model) args.push("--model", options.model);
if (options.mode) args.push("--mode", options.mode);
if (options.cwd) args.push("--add-dir", options.cwd);
```

Resolve `start()` only after parsing an `init` event. Retain the last 2 KiB of stderr for startup and exit diagnostics.

- [ ] **Step 4: Implement ordered NDJSON turns**

Write exactly one line per prompt:

```ts
const input = {
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: prompt }],
  },
};
child.stdin.write(`${JSON.stringify(input)}\n`);
```

Use one promise chain for decoded stdout lines. Route `step_update` and `result` through the existing callback vocabulary. Resolve a turn at its `result`, not at process exit.

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npx tsx --test test/agy-worker.test.ts`

Expected: PASS, including a single fixture startup for two turns.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/agy/worker.ts test/agy-worker.test.ts
git commit -m "feat: add persistent AGY stream worker"
```

---

### Task 4: AGY Session Ownership And Reconfiguration

**Files:**
- Create: `test/agy-adapter.test.ts`
- Modify: `src/adapters/agy/index.ts:151-396`

**Interfaces:**
- Consumes: `AgyWorker` from Task 3.
- Produces: `Map<string, AgySessionRuntime>` keyed only by ACP session ID.
- `AgySessionRuntime` contains `worker`, `preparation`, `model`, `mode`, and `conversationId`.

- [ ] **Step 1: Write failing adapter tests**

```ts
test("AGY creates one isolated worker per ACP session", async () => {
  const adapter = createFixtureAgyAdapter(logPath);
  const first = session("acp-one");
  const second = session("acp-two");
  adapter.createSession(first);
  adapter.createSession(second);
  await Promise.all([
    adapter.executeTurn(turn(first.id, "one")),
    adapter.executeTurn(turn(second.id, "two")),
  ]);
  assert.equal(await countLogRecords(logPath, "startup"), 2);
  await adapter.dispose();
});

test("AGY replaces an unused worker when configuration changes", async () => {
  const adapter = createFixtureAgyAdapter(logPath);
  const state = session("acp-one");
  adapter.createSession(state);
  state.model = "Gemini 3.1 Pro (High)";
  await adapter.updateSession(state);
  await adapter.executeTurn(turn(state.id, "one"));
  const starts = await readLogRecords(logPath, "startup");
  assert.equal(starts.at(-1)?.model, "Gemini 3.1 Pro (High)");
  await adapter.dispose();
});
```

Also prove that cancellation and close affect only the target ACP session.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --test test/agy-adapter.test.ts`

Expected: FAIL because the adapter still spawns once per turn and has no worker map.

- [ ] **Step 3: Replace per-turn spawning with session workers**

`createSession()` starts preparation without awaiting it. `executeTurn()` awaits the stored preparation and calls `worker.runTurn()`. Remove `continueSession` and the global `-c` path from AGY execution.

Use explicit defaults when `SessionState` has not yet received config calls:

```ts
const DEFAULT_AGY_MODEL = "Gemini 3.7 Flash (High)";
const DEFAULT_AGY_MODE = "accept-edits";
```

- [ ] **Step 4: Implement replacement, cancellation, and disposal**

Before first use, replace a worker whose launch model or mode differs from current session state. After use, restart with `--conversation <conversationId>`; if the installed CLI rejects resume plus stream input, reject the config update with a message that names the unsupported operation.

- [ ] **Step 5: Run focused and full tests**

Run: `npx tsx --test test/agy-worker.test.ts test/agy-adapter.test.ts`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/agy/index.ts test/agy-adapter.test.ts
git commit -m "feat: reuse AGY workers per ACP session"
```

---

### Task 5: Incremental SSE Parser And AtomCode Daemon Client

**Files:**
- Create: `src/adapters/atomcode/sse.ts`
- Create: `src/adapters/atomcode/daemon.ts`
- Create: `test/atomcode-sse.test.ts`
- Create: `test/atomcode-daemon.test.ts`

**Interfaces:**
- Consumes: `ProcessCommand`, `spawnCommand`, `terminateProcess`, and `TimingTrace`.
- Produces: `SseParser.push(chunk): string[]` and `SseParser.finish(): string[]` where each string is one `data:` payload.
- Produces: `AtomCodeDaemon.start(): Promise<void>`.
- Produces: `createSession(cwd): Promise<AtomCodeSession>`.
- Produces: `chat(request, onEvent, signal?): Promise<void>`.
- Produces: `stop(sessionOrRequestId): Promise<void>` and `dispose(): Promise<void>`.

- [ ] **Step 1: Write failing SSE boundary tests**

```ts
test("SSE parser preserves events split across arbitrary chunks", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"type\":\"te"), []);
  assert.deepEqual(parser.push("xt\",\"content\":\"a\"}\n\nda"), [
    "{\"type\":\"text\",\"content\":\"a\"}",
  ]);
  assert.deepEqual(parser.push("ta: {\"type\":\"done\"}\r\n\r\n"), [
    "{\"type\":\"done\"}",
  ]);
});
```

- [ ] **Step 2: Run the SSE test and verify RED**

Run: `npx tsx --test test/atomcode-sse.test.ts`

Expected: FAIL because `SseParser` does not exist.

- [ ] **Step 3: Implement minimal SSE framing**

Normalize CRLF only at frame boundaries, ignore comment/keepalive fields, join multiple `data:` lines with `\n`, and retain an incomplete final frame until `finish()`.

- [ ] **Step 4: Write failing daemon lifecycle test**

```ts
test("AtomCode daemon starts once and streams before done", async () => {
  const daemon = createFixtureDaemon(logPath);
  await daemon.start();
  const native = await daemon.createSession(process.cwd());
  const events: string[] = [];
  await daemon.chat(
    { message: "hello", working_dir: process.cwd(), session_id: native.id, request_id: "req-1" },
    (event) => events.push(event.type),
  );
  assert.deepEqual(events.slice(0, 3), ["runtime_info", "session_assigned", "text"]);
  assert.equal(await countLogRecords(logPath, "startup"), 1);
  await daemon.dispose();
});
```

- [ ] **Step 5: Run daemon test and verify RED**

Run: `npx tsx --test test/atomcode-daemon.test.ts`

Expected: FAIL because `AtomCodeDaemon` does not exist.

- [ ] **Step 6: Implement private daemon lifecycle**

Reserve a loopback port with a temporary Node server bound to port `0`, close it, then launch:

```ts
[
  "daemon",
  "--port", String(port),
  "--client", "atomcode-acp",
  "--idle-timeout", "0",
  "--no-telemetry",
]
```

Poll `GET /health` with a bounded timeout. Use `POST /shutdown` before process termination. Store only the most recent 2 KiB of stderr.

- [ ] **Step 7: Implement typed HTTP and streaming chat**

Send `working_dir`, `session_id`, and `request_id` exactly as named by the daemon schema. Read `response.body` with a stream reader, feed decoded chunks to `SseParser`, parse each payload once, and invoke `onEvent` immediately.

- [ ] **Step 8: Verify GREEN**

Run: `npx tsx --test test/atomcode-sse.test.ts test/atomcode-daemon.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/adapters/atomcode/sse.ts src/adapters/atomcode/daemon.ts test/atomcode-sse.test.ts test/atomcode-daemon.test.ts
git commit -m "feat: add persistent AtomCode daemon client"
```

---

### Task 6: AtomCode Adapter Session And Event Mapping

**Files:**
- Create: `test/atomcode-adapter.test.ts`
- Modify: `src/adapters/atomcode/index.ts:132-307`

**Interfaces:**
- Consumes: `AtomCodeDaemon` and daemon event objects from Task 5.
- Produces: ACP-session-to-native-session map with `nativeSessionId`, `cwd`, `activeRequestId`, and readiness.
- Produces mappings from `text`, `reasoning`, `tool_start`, `tool_result`, `tokens`, `done`, `stopped`, and `error` events to `ExecuteTurnOptions` callbacks.

- [ ] **Step 1: Write failing adapter tests**

```ts
test("AtomCode reuses one daemon across sessions and turns", async () => {
  const adapter = createFixtureAtomCodeAdapter(logPath);
  await adapter.start();
  const first = session("acp-one");
  const second = session("acp-two");
  adapter.createSession(first);
  adapter.createSession(second);
  await adapter.executeTurn(turn(first.id, "one"));
  await adapter.executeTurn(turn(first.id, "two"));
  await adapter.executeTurn(turn(second.id, "three"));
  assert.equal(await countLogRecords(logPath, "startup"), 1);
  assert.equal(await countLogRecords(logPath, "chat"), 3);
  await adapter.dispose();
});

test("AtomCode forwards text before the terminal done event", async () => {
  const adapter = createFixtureAtomCodeAdapter(logPath);
  const state = session("acp-one");
  adapter.createSession(state);
  const order: string[] = [];
  await adapter.executeTurn(turn(state.id, "one", {
    onChunk: (text) => order.push(`text:${text}`),
    onMetrics: () => order.push("metrics"),
  }));
  assert.equal(order[0], "text:hello");
  await adapter.dispose();
});
```

Also assert reasoning, tool IDs, token metrics, error rejection, and session-scoped stop request mapping.

- [ ] **Step 2: Run tests and verify RED**

Run: `npx tsx --test test/atomcode-adapter.test.ts`

Expected: FAIL because the adapter still executes the headless binary per turn.

- [ ] **Step 3: Replace headless execution with daemon calls**

`start()` starts the daemon. `createSession()` begins `POST /sessions` using the ACP session cwd. `executeTurn()` awaits that session preparation and calls `/chat` with a fresh UUID request ID.

Pass the selected AtomCode model through the daemon request's `provider` field because daemon model selections are provider-selection identifiers. Preserve these defaults:

```ts
const DEFAULT_ATOMCODE_MODEL = "deepseek-v4-flash";
const DEFAULT_ATOMCODE_MODE = "code";
```

- [ ] **Step 4: Implement event mapping and cancellation**

Map events without batching. Treat `stopped` as a cancelled turn, `error` as a rejected turn, and `done` as completion. Use request ID for cancellation before `session_assigned`, then canonical native session ID afterward.

- [ ] **Step 5: Run focused tests and build**

Run: `npx tsx --test test/atomcode-sse.test.ts test/atomcode-daemon.test.ts test/atomcode-adapter.test.ts`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/adapters/atomcode/index.ts test/atomcode-adapter.test.ts
git commit -m "feat: route AtomCode sessions through daemon"
```

---

### Task 7: ACP Server Lifecycle, Defaults, And Cleanup

**Files:**
- Create: `test/acp-lifecycle.test.ts`
- Modify: `src/acp/server.ts:36-288`
- Modify: `src/index.ts:16-34`
- Modify: `src/session/manager.ts:27-136`

**Interfaces:**
- Consumes: the complete `AgentAdapter` lifecycle from Task 2.
- Produces: adapter startup at ACP creation, session preparation at `session/new`, update on `session/set_config_option`, session-keyed turn dispatch, cancellation, and process cleanup.
- Produces: `createAgentServer(adapter).dispose(): Promise<void>` through a returned server handle or an equivalent explicit cleanup closure used by `main()`.

- [ ] **Step 1: Write failing ACP lifecycle test**

Use a recording adapter and the SDK NDJSON client harness to send `initialize`, `session/new`, `session/set_config_option`, `session/prompt`, `session/cancel`, and `session/close`. Assert this exact prefix:

```ts
assert.deepEqual(calls.slice(0, 5), [
  "start",
  "createSession",
  "updateSession",
  "executeTurn",
  "cancelTurn",
]);
assert.equal(executeOptions.sessionId, sessionId);
assert.equal(calls.at(-1), "closeSession");
```

Also verify that default config values populate `session.model` and `session.mode` before `createSession()` is invoked.

- [ ] **Step 2: Run test and verify RED**

Run: `npx tsx --test test/acp-lifecycle.test.ts`

Expected: FAIL because the server does not call adapter lifecycle methods or pass `sessionId`.

- [ ] **Step 3: Wire startup and session defaults**

Start the adapter once when creating the ACP server and keep the readiness promise. During `session/new`, read the adapter config options, copy string `currentValue` values for IDs `model`, `mode`, and `provider` into `SessionState`, then call `adapter.createSession(session)` without awaiting prewarming.

- [ ] **Step 4: Wire config, prompt, and cancellation**

After `SessionManager.setSessionOption`, await `adapter.updateSession(session)`. Include `sessionId` in `executeTurn`. Replace direct AbortController-only cancellation with `adapter.cancelTurn(sessionId)` plus the existing signal so callback and backend cleanup both occur.

Register both `acp.methods.agent.session.close` and
`acp.methods.agent.session.delete`. Each handler must await
`adapter.closeSession(sessionId)` and remove the in-memory `SessionState`.
Repeated close or delete calls return successfully after the first cleanup.

- [ ] **Step 5: Wire shutdown**

Make cleanup idempotent. When ACP stdin closes or its connection aborts, cancel active sessions, close their backend state, and await `adapter.dispose()` before natural exit. Do not call `process.exit()` before cleanup finishes.

- [ ] **Step 6: Run lifecycle and regression tests**

Run: `npx tsx --test test/acp-lifecycle.test.ts`

Run: `npm test`

Run: `npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/acp/server.ts src/index.ts src/session/manager.ts test/acp-lifecycle.test.ts
git commit -m "feat: connect ACP and backend lifecycles"
```

---

### Task 8: Diagnostics, Documentation, And End-To-End Verification

**Files:**
- Create: `test/persistent-backends.test.ts`
- Modify: `README.md:36-47`
- Modify: `README.md:107-114`

**Interfaces:**
- Consumes: both completed persistent adapters and `TimingTrace`.
- Produces: a non-metered end-to-end regression that drives the compiled ACP server against fake backend executables.

- [ ] **Step 1: Write the failing compiled-server regression**

Spawn `dist/index.js` twice. For AGY set `ACP_ADAPTER=agy`,
`AGY_PATH=process.execPath`, and `AGY_ARGS_PREFIX_JSON` to the JSON array
containing the absolute fake-AGY fixture path. For AtomCode set
`ACP_ADAPTER=atomcode`, `ATOMCODE_PATH=process.execPath`, and
`ATOMCODE_ARGS_PREFIX_JSON` to the JSON array containing the absolute
fake-AtomCode fixture path. For each server, run two prompts in one ACP session
and assert:

```ts
assert.equal(first.stopReason, "end_turn");
assert.equal(second.stopReason, "end_turn");
assert.equal(messageText, "hello worldhello world");
assert.equal(startupCount, 1);
```

The test must close ACP stdin and wait for both the bridge and fake backend processes to exit.

With `ACP_TIMING=1`, capture stderr and assert it contains
`prompt_received`, `backend_accepted`, `first_event`, `first_text`, and
`turn_completed` in chronological order. Without that variable, assert none of
those timing labels are written.

- [ ] **Step 2: Run the regression and verify RED**

Run: `npm run build`

Run: `npx tsx --test test/persistent-backends.test.ts`

Expected: FAIL until the compiled entrypoint exposes fixture command-prefix configuration and awaits cleanup correctly.

- [ ] **Step 3: Add test-only command-prefix environment parsing**

Support `ATOMCODE_ARGS_PREFIX_JSON` and `AGY_ARGS_PREFIX_JSON` only when present, parse each as a JSON string array, and prepend it through `ProcessCommand`. Production manifests remain unchanged.

- [ ] **Step 4: Document the persistent behavior and diagnostics**

Update README statements so they say:

- AtomCode uses one private daemon per ACP process.
- AGY uses one stream-json worker per ACP session.
- `ACP_TIMING=1` reports readiness, backend acceptance, first event, first thought, first text, and completion timings to stderr.
- `npm test` is non-metered; `npm run test:live:atomcode` and `npm run test:live:agy` consume configured provider access.

- [ ] **Step 5: Run all automated verification**

Run: `npm test`

Run: `npm run build`

Run: `git diff --check`

Expected: all pass with no live provider calls and no whitespace errors.

- [ ] **Step 6: Perform optional manual timing verification**

With the user's normal CodeG environment and `ACP_TIMING=1`, send two short prompts in one session. Confirm the second prompt has no backend startup interval and that `first_text` follows the backend's first text event without an adapter batching delay. Do not make this live check a requirement for the automated suite.

- [ ] **Step 7: Commit**

```powershell
git add README.md src test package.json
git commit -m "test: verify persistent ACP backend reuse"
```

## Final Acceptance

- [ ] `npm test` passes without contacting a model provider.
- [ ] `npm run build` passes under strict TypeScript settings.
- [ ] Two turns in one AGY ACP session produce one AGY fixture startup.
- [ ] Multiple AGY ACP sessions have different workers and conversation IDs.
- [ ] AtomCode sessions and turns share one private daemon process.
- [ ] First text is observed before terminal completion for both transports.
- [ ] Cancellation is scoped to the requested session.
- [ ] Backend crashes reject only the active prompt and never replay it.
- [ ] Closing ACP stdin leaves no adapter-owned child process alive.
- [ ] `ACP_TIMING=1` writes timing records only to stderr.
