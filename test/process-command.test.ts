import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
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

function parseSseEventNames(stream: string): string[] {
  return stream
    .trim()
    .split("\n\n")
    .map((frame) => frame.match(/^event: (.+)$/m)?.[1])
    .filter((name): name is string => name !== undefined);
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

test("fake AtomCode daemon streams text before reasoning", async () => {
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
    assert.deepEqual(parseSseEventNames(await chat.text()), [
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
  } finally {
    await terminateProcess(child, 50);
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
    assert.equal((await fetch(`http://127.0.0.1:${port}/sessions`, { method: "POST" })).status, 200);
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
    await terminateProcess(child, 50);
    await rm(directory, { recursive: true, force: true });
  }
});
