# Persistent Backend Design

## Goal

Reduce time to first visible output in CodeG by removing per-turn backend CLI
startup. The ACP bridge will keep AtomCode and AGY runtimes alive for the
lifetime of the relevant ACP process or session, following the same high-level
pattern as `codex-acp` and its long-running Codex app-server connection.

Success means:

- AtomCode does not spawn a headless CLI process for every prompt.
- AGY does not start a language server, authenticate, and load model metadata
  again for every prompt in the same ACP session.
- Concurrent ACP sessions do not share conversation state accidentally.
- Text and thought deltas are forwarded as soon as the backend emits them.
- Cancellation and backend crashes do not cause a completed tool action to be
  replayed automatically.

## Current Problem

Both adapters currently call `spawn()` inside `executeTurn()`. AtomCode runs a
new `atomcode -p` process, and AGY runs a new `agy -p` process on every turn.
The ACP server itself is persistent, but the expensive backend initialization
is not.

The AGY startup path includes language-server creation, authentication, model
configuration, workspace discovery, and customization loading. AtomCode also
offers a daemon specifically intended for IDE integrations, but the current
adapter bypasses it.

## Chosen Architecture

### Adapter lifecycle

Extend the adapter boundary with explicit lifecycle operations:

- `start()` prepares shared backend infrastructure.
- `createSession(session)` prepares backend state for an ACP session.
- `executeTurn(options)` sends a turn through the prepared backend.
- `cancelTurn(sessionId)` interrupts the active turn.
- `closeSession(sessionId)` releases session-owned resources.
- `dispose()` shuts down adapter-owned processes and connections.

`ExecuteTurnOptions` will carry the ACP session ID. Backend conversation
identity will be stored per session rather than inferred from a global
"continue most recent conversation" flag.

The ACP server will begin adapter startup as soon as it is created. Session
creation may start session-specific preparation without delaying unrelated ACP
handshake work. Prompt execution waits for the relevant readiness promise.

### AtomCode transport

The AtomCode adapter owns one `atomcode daemon` process shared by all ACP
sessions.

- Bind only to `127.0.0.1` on a private dynamically selected port.
- Do not reuse the conventional port 13456, because another editor may own it
  and daemon workspace state must not be changed behind that editor's back.
- Start the daemon with telemetry disabled and a disabled idle timeout.
- Poll `GET /health` until ready, with a bounded startup timeout.
- Create and track native sessions through `POST /sessions`.
- Send prompts through `POST /chat`, including the ACP session's explicit
  `working_dir`, native `session_id`, and a unique first-turn `request_id`.
  Record the canonical identity from `session_assigned` before later turns.
- Map text, reasoning, tool, token, completion, and error events directly to
  the existing adapter callbacks.
- Cancel an active turn through `POST /chat/stop`.
- Shut down only the daemon process owned by this ACP instance.

The adapter must never buffer the full SSE response before invoking callbacks.
It will parse complete SSE frames from each network chunk while retaining only
an incomplete trailing frame.

The daemon supports request-scoped working directories and rejects concurrent
turns only when they target the same native session. One private daemon can
therefore serve ACP sessions from different workspaces without changing its
process-global current directory or serializing unrelated turns.

### AGY transport

The AGY adapter owns one long-running stream-json worker per ACP session.

- Start preparation during `session/new` so CLI initialization normally
  overlaps the time a user spends composing the first prompt.
- Launch AGY with `--input-format stream-json` and
  `--output-format stream-json`.
- Wait for the `init` event and retain its `conversation_id`.
- Encode each prompt as one NDJSON user message and write it to stdin.
- Route `step_update` deltas immediately and resolve the turn when its terminal
  `result` event arrives.
- Keep the worker alive after a result so the next prompt reuses its process,
  authentication, language server, and conversation context.

An AGY worker processes one turn at a time. ACP sessions never share a worker.
Model and mode selections are part of worker launch configuration. If either
changes before the first prompt, the unused worker is replaced. If either
changes after conversation use, the worker is replaced and resumed with its
recorded conversation ID when the installed AGY version supports that
combination; otherwise the adapter returns an explicit unsupported-change
error rather than silently losing context.

### Session identity

The ACP session ID is the primary bridge key. Each entry stores:

- Backend-native session or conversation ID.
- Readiness state.
- Active turn state.
- Selected model and mode used to launch the backend.
- Cancellation and cleanup state.

The existing process-global `-c` behavior will not be used for session routing.
This prevents one CodeG tab from continuing the most recently active
conversation belonging to another tab.

## Streaming And Ordering

Backend events must be delivered to ACP in their original order. Node stream
callbacks will enqueue parsing and callback work on a per-worker promise chain
instead of using independent async `data` handlers, which can overlap and
reorder notifications.

There is no token batching timer. Sanitization may transform a received delta,
but a non-empty delta is sent to the ACP client immediately.

AGY output remains line framed because its protocol is NDJSON. AtomCode output
remains SSE framed. Neither adapter waits for process exit to flush a completed
turn.

## Cancellation And Failure Recovery

Cancellation is scoped to a turn whenever the backend supports it:

- AtomCode calls `/chat/stop` and keeps the daemon and session alive.
- AGY cancellation terminates only that session's worker when no turn-level
  input message is available. The next turn may resume from the last known
  backend conversation ID.

When a backend exits unexpectedly, the adapter rejects the active turn with a
diagnostic error and marks the runtime unavailable. It may rebuild the runtime
for a later prompt, but it must not replay the failed prompt automatically.
Automatic replay is unsafe because tools may already have changed files.

Startup has a bounded timeout and includes recent stderr in its error. Adapter
shutdown is idempotent. Process termination first requests graceful shutdown,
then force-kills only after a short timeout.

## Timing Diagnostics

When `ACP_TIMING=1` is set, write concise timing records to stderr for:

- Adapter startup began and became ready.
- Session preparation began and became ready.
- Prompt received.
- Prompt accepted by the backend.
- First backend event.
- First thought delta.
- First text delta.
- Turn completed.

Logs use monotonic elapsed durations and never write to stdout, which is
reserved for ACP protocol traffic.

## Testing

Tests will use small fake HTTP/SSE and NDJSON child-process fixtures rather
than live model calls.

Required coverage:

- AtomCode daemon starts once across multiple turns and sessions.
- AtomCode SSE chunks split at arbitrary byte boundaries are emitted in order.
- AGY worker starts once per session and accepts multiple prompt messages.
- Two AGY sessions use different workers and conversation IDs.
- Prompt deltas are forwarded before the terminal result or process exit.
- Cancellation affects only the requested turn or session.
- Backend startup failure and unexpected exit reject the correct prompt.
- Model or mode changes replace only the affected unused worker.
- `dispose()` is idempotent and leaves no child processes running.
- Existing parser, local-command, and ACP handshake tests remain green.

Implementation follows test-driven development: each lifecycle and streaming
behavior receives a failing test before production code changes.

## Compatibility And Rollout

- Keep the existing public executable names and distribution manifests.
- Preserve `ATOMCODE_PATH` and `AGY_PATH` overrides.
- Add optional environment overrides for backend startup timeouts and timing
  logs only where tests or diagnostics require them.
- Use the installed AtomCode daemon and AGY stream-input capabilities; report a
  clear version/capability error when an older binary lacks them.
- Do not add an automatic one-shot fallback by default. Silent fallback would
  hide latency regressions and reintroduce ambiguous global continuation.

## References

- `codex-acp` starts one Codex app-server at ACP startup and sends turns over a
  persistent JSON-RPC connection:
  <https://github.com/agentclientprotocol/codex-acp/blob/main/src/index.ts>
- Codex persistent process connection:
  <https://github.com/agentclientprotocol/codex-acp/blob/main/src/CodexJsonRpcConnection.ts>
- AtomCode daemon HTTP and SSE API:
  <https://atomcode.atomgit.com/docs/en/headless-daemon.html>
