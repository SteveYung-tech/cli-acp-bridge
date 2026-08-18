import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import * as acp from "@agentclientprotocol/sdk";

type AdapterId = "agy" | "atomcode";

const fixtures: Record<AdapterId, string> = {
  agy: join(process.cwd(), "test", "fixtures", "fake-agy.mjs"),
  atomcode: join(process.cwd(), "test", "fixtures", "fake-atomcode.mjs"),
};

async function runCompiledServer(adapter: AdapterId, timing: boolean) {
  const directory = await mkdtemp(join(tmpdir(), `persistent-${adapter}-`));
  const logPath = join(directory, "backend.log");
  const prefixVariable = adapter === "agy" ? "AGY_ARGS_PREFIX_JSON" : "ATOMCODE_ARGS_PREFIX_JSON";
  const binaryVariable = adapter === "agy" ? "AGY_PATH" : "ATOMCODE_PATH";
  const env = {
    ...process.env,
    ACP_ADAPTER: adapter,
    ACP_TIMING: timing ? "1" : undefined,
    FAKE_BACKEND_LOG: logPath,
    [binaryVariable]: process.execPath,
    [prefixVariable]: JSON.stringify([fixtures[adapter]]),
  };
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js")], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = once(child, "exit");
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const messages: string[] = [];
  const client = acp.client({ name: `persistent-${adapter}-test` })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const update = ctx.params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        messages.push(update.content.text);
      }
    });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
  );
  const connection = client.connect(stream);

  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const session = await connection.agent.request(acp.methods.agent.session.new, {
      cwd: process.cwd(),
      mcpServers: [],
    });
    const first = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "one" }],
    });
    const second = await connection.agent.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "two" }],
    });

    assert.equal(first.stopReason, "end_turn");
    assert.equal(second.stopReason, "end_turn");
    assert.equal(messages.join(""), "hello worldhello world");

    connection.close();
    child.stdin.end();
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          exitTimer = setTimeout(() => reject(new Error(`compiled ACP server did not exit:\n${stderr}`)), 5_000);
        }),
      ]);
    } finally {
      if (exitTimer) clearTimeout(exitTimer);
    }
    await connection.closed;

    const records = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(records.filter((record) => record.event === "startup").length, 1);

    const required = ["prompt_received", "backend_accepted", "first_event", "first_text", "turn_completed"];
    if (timing) {
      const labels = [...stderr.matchAll(/\bmark=([^\s]+)/g)].map((match) => match[1]);
      let cursor = -1;
      for (const label of required) {
        cursor = labels.indexOf(label, cursor + 1);
        assert.notEqual(cursor, -1, `missing or out-of-order ${label} in ${adapter} timing output:\n${stderr}`);
      }
      assert.ok(labels.includes("first_thought"), `missing first_thought in ${adapter} timing output`);
    } else {
      for (const label of required) assert.doesNotMatch(stderr, new RegExp(`\\bmark=${label}\\b`));
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill("SIGKILL");
      await exited.catch(() => undefined);
    }
    await rm(directory, { recursive: true, force: true });
  }
}

for (const adapter of ["agy", "atomcode"] as const) {
  test(`${adapter} compiled ACP server reuses its persistent backend and emits ordered timing`, async () => {
    await runCompiledServer(adapter, true);
  });

  test(`${adapter} compiled ACP server keeps timing diagnostics disabled by default`, async () => {
    await runCompiledServer(adapter, false);
  });
}
