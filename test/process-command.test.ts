import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawnCommand, terminateProcess } from "../src/runtime/process-command.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "fake-atomcode.mjs");

async function reservePort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The fixture daemon has not started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fake AtomCode daemon did not become healthy");
}

function parseSseData(stream: string): Record<string, unknown>[] {
  return stream
    .trim()
    .split("\n\n")
    .map((frame) => frame.match(/^data: (.+)$/m)?.[1])
    .filter((payload): payload is string => payload !== undefined)
    .map((payload) => JSON.parse(payload));
}

async function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<"completed" | "timed out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => "completed" as const),
      new Promise<"timed out">((resolve) => {
        timer = setTimeout(() => resolve("timed out"), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stopChild(child: ReturnType<typeof spawnCommand>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

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

test("terminateProcess is idempotent after signal termination", async () => {
  const child = spawnCommand(
    { command: process.execPath, argsPrefix: ["-e", "process.stdin.resume(); setInterval(() => {}, 1_000)"] },
    [],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.notEqual(child.signalCode, null);
  assert.equal(await settlesWithin(terminateProcess(child, 50), 250), "completed");
});

test("terminateProcess forcefully ends a child that ignores stdin and SIGTERM", async () => {
  const child = spawnCommand(
    {
      command: process.execPath,
      argsPrefix: ["-e", "process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
    },
    [],
    { stdio: ["pipe", "pipe", "pipe"] },
  );

  try {
    assert.equal(await settlesWithin(terminateProcess(child, 50), 1_000), "completed");
  } finally {
    await stopChild(child);
  }
});

test("terminateProcess rejects when forced process-tree termination fails", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    pid: 999_999,
    stdin: { end() {} },
    kill: () => false,
  }) as unknown as ReturnType<typeof spawnCommand>;
  const result = Promise.race([
    terminateProcess(child, 10),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), 2_000)),
  ]);
  await assert.rejects(result, /Unable to forcefully terminate child process/);
});

test("fake AtomCode daemon emits ChatEvent JSON data frames", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-acp-fixture-"));
  const logPath = join(directory, "backend.log");
  const port = await reservePort();
  const child = spawn(process.execPath, [fixturePath, "daemon", "--port", String(port)], {
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port);
    const chat = await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify({ message: "hello" }) });
    assert.equal(chat.headers.get("content-type"), "text/event-stream");
    const events = parseSseData(await chat.text());
    assert.deepEqual(events.map((event) => event.type), [
      "runtime_info",
      "session_assigned",
      "text",
      "reasoning",
      "tool_start",
      "tool_result",
      "text",
      "tokens",
      "done",
    ]);
    assert.deepEqual(events[2], { type: "text", content: "hello" });
    assert.deepEqual(events[3], { type: "reasoning", content: "thinking" });
    assert.deepEqual(events[4], { type: "tool_start", id: "tool-1", name: "fake_tool", arguments: {} });
    assert.deepEqual(events[5], {
      type: "tool_result",
      id: "tool-1",
      name: "fake_tool",
      output: "fake output",
      success: true,
      duration_ms: 1,
    });
    assert.deepEqual(events[7], { type: "tokens", prompt: 3, completion: 2, total: 5 });
    assert.deepEqual(events[8], {
      type: "done",
      session_id: "fake-session",
      stop_reason: "end_turn",
      tokens: 5,
      tool_calls: 1,
    });
  } finally {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("fake AtomCode daemon logs startup and every request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-acp-fixture-"));
  const logPath = join(directory, "backend.log");
  const port = await reservePort();
  const child = spawn(process.execPath, [fixturePath, "daemon", "--port", String(port)], {
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port);
    const session = await fetch(`http://127.0.0.1:${port}/sessions`, { method: "POST" });
    assert.equal(session.status, 201);
    assert.deepEqual(await session.json(), {
      id: "fake-session",
      name: "fake-session",
      working_dir: "fixture",
      project_hash: "fake-project",
      created_at: "2026-08-18T00:00:00.000Z",
    });
    assert.equal((await fetch(`http://127.0.0.1:${port}/chat`, { method: "POST", body: JSON.stringify({ message: "hello" }) })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/chat/stop`, { method: "POST" })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST" })).status, 200);
    await once(child, "exit");
    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.event === "startup").length, 1);
    assert.deepEqual(records.filter((record) => record.event === "request").map((record) => `${record.method} ${record.url}`), [
      "GET /health",
      "POST /sessions",
      "POST /chat",
      "POST /chat/stop",
      "POST /shutdown",
    ]);
  } finally {
    await stopChild(child);
    await rm(directory, { recursive: true, force: true });
  }
});
