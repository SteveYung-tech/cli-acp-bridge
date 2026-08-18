import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AtomCodeDaemon } from "../src/adapters/atomcode/daemon.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "fake-atomcode.mjs");

async function records(logPath: string, event: string): Promise<any[]> {
  const content = await readFile(logPath, "utf8");
  return content.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((record) => record.event === event);
}

test("AtomCode daemon starts once, creates native sessions, and streams typed events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atomcode-daemon-"));
  const logPath = join(directory, "backend.log");
  const daemon = new AtomCodeDaemon({
    command: { command: process.execPath, argsPrefix: [fixturePath] },
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    startupTimeoutMs: 1_000,
  });
  try {
    await Promise.all([daemon.start(), daemon.start()]);
    const native = await daemon.createSession(process.cwd());
    assert.equal(native.id, "fake-session-1");
    const events: string[] = [];
    await daemon.chat(
      { message: "hello", working_dir: process.cwd(), session_id: native.id, request_id: "req-1" },
      (event) => events.push(event.type),
    );
    assert.deepEqual(events.slice(0, 4), ["runtime_info", "session_assigned", "text", "reasoning"]);
    assert.equal(events.at(-1), "done");
    await daemon.stop(native.id);
    assert.equal((await records(logPath, "startup")).length, 1);
  } finally {
    await daemon.dispose();
    await daemon.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AtomCode daemon startup failure is bounded and includes stderr", async () => {
  const daemon = new AtomCodeDaemon({
    command: {
      command: process.execPath,
      argsPrefix: ["-e", "process.stderr.write('daemon failed'); process.exit(7)", "--"],
    },
    startupTimeoutMs: 500,
  });
  await assert.rejects(daemon.start(), /daemon failed|code 7/i);
  await daemon.dispose();
});

test("disposing during daemon startup rejects start promptly and is idempotent", async () => {
  const daemon = new AtomCodeDaemon({
    command: {
      command: process.execPath,
      argsPrefix: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)", "--"],
    },
    startupTimeoutMs: 2_000,
  });
  const start = daemon.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  const disposal = Promise.all([daemon.dispose(), daemon.dispose()]);
  await assert.rejects(start, /disposed/i);
  await Promise.race([
    disposal,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("dispose timed out")), 2_000)),
  ]);
});
