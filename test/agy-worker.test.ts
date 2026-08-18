import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgyWorker } from "../src/adapters/agy/worker.js";
import type { ProcessCommand } from "../src/runtime/process-command.js";
import { TimingTrace } from "../src/runtime/timing.js";

const fixturePath = join(process.cwd(), "test", "fixtures", "fake-agy.mjs");

function createFixtureWorker(logPath: string): AgyWorker {
  return new AgyWorker({
    command: { command: process.execPath, argsPrefix: [fixturePath] },
    cwd: process.cwd(),
    env: { ...process.env, FAKE_BACKEND_LOG: logPath },
    startupTimeoutMs: 500,
  });
}

function scriptedCommand(source: string): ProcessCommand {
  return { command: process.execPath, argsPrefix: ["-e", source, "--"] };
}

function createScriptedWorker(source: string, options: Partial<ConstructorParameters<typeof AgyWorker>[0]> = {}): AgyWorker {
  return new AgyWorker({
    command: scriptedCommand(source),
    cwd: process.cwd(),
    startupTimeoutMs: 500,
    ...options,
  });
}

async function countLogRecords(logPath: string, event: string): Promise<number> {
  const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return records.filter((record) => record.event === event).length;
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("promise timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("one AGY worker handles two turns without restarting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-worker-"));
  const logPath = join(directory, "backend.log");
  const worker = createFixtureWorker(logPath);
  try {
    await worker.start();
    assert.equal(worker.conversationId, "fake-conversation");
    assert.equal(worker.used, false);
    const first: string[] = [];
    const second: string[] = [];
    await worker.runTurn("one", { onChunk: (text) => first.push(text) });
    await worker.runTurn("two", { onChunk: (text) => second.push(text) });
    assert.equal(await countLogRecords(logPath, "startup"), 1);
    assert.deepEqual(first, ["hello", " world"]);
    assert.deepEqual(second, ["hello", " world"]);
    assert.equal(worker.used, true);

    const records = (await readFile(logPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(records.filter((record) => record.event === "prompt").map((record) => record.message), [
      { type: "user", message: { role: "user", content: [{ type: "text", text: "one" }] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: "two" }] } },
    ]);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY launch arguments use the required order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-worker-args-"));
  const argsPath = join(directory, "args.json");
  const source = `require("node:fs").writeFileSync(process.env.ARGS_PATH, JSON.stringify(process.argv.slice(1))); console.log(JSON.stringify({event:"init",conversation_id:"from-init"})); process.stdin.resume()`;
  const worker = createScriptedWorker(source, {
    cwd: directory,
    model: "test-model",
    mode: "test-mode",
    conversationId: "existing-conversation",
    env: { ...process.env, ARGS_PATH: argsPath },
  });
  try {
    await worker.start();
    assert.deepEqual(JSON.parse(await readFile(argsPath, "utf8")), [
      "-p", "", "--input-format", "stream-json", "--output-format", "stream-json",
      "--dangerously-skip-permissions", "--conversation", "existing-conversation",
      "--model", "test-model", "--mode", "test-mode", "--add-dir", directory,
    ]);
    assert.equal(worker.conversationId, "from-init");
    assert.equal(worker.model, "test-model");
    assert.equal(worker.mode, "test-mode");
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("AGY rejects overlapping turns on one worker", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); let n=0; process.stdin.on("data",()=>{ if(++n===1) setTimeout(()=>console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"ok"}})),50) })`;
  const worker = createScriptedWorker(source);
  try {
    await worker.start();
    const active = worker.runTurn("one", {});
    await assert.rejects(worker.runTurn("two", {}), /already active/);
    await settlesWithin(active);
  } finally {
    await worker.dispose();
  }
});

test("AGY start times out and includes retained stderr diagnostics", async () => {
  const worker = createScriptedWorker(`process.stderr.write("startup details"); process.stdin.resume()`, { startupTimeoutMs: 500 });
  await assert.rejects(settlesWithin(worker.start()), /timed out.*startup details/i);
  await settlesWithin(worker.dispose());
});

test("AGY rejects malformed NDJSON instead of leaving a turn pending", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.once("data",()=>console.log("not-json"))`;
  const worker = createScriptedWorker(source);
  try {
    await worker.start();
    await assert.rejects(settlesWithin(worker.runTurn("hello", {})), /malformed.*NDJSON/i);
  } finally {
    await worker.dispose();
  }
});

test("AGY rejects an error result and can process the next turn", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); let n=0,b=""; process.stdin.on("data",d=>{b+=d; while(b.includes("\\n")){b=b.slice(b.indexOf("\\n")+1); n++; console.log(JSON.stringify({event:"result",result:n===1?{status:"ERROR",error:"bad turn"}:{status:"SUCCESS",response:"recovered"}}))}})`;
  const worker = createScriptedWorker(source);
  try {
    await worker.start();
    await assert.rejects(settlesWithin(worker.runTurn("bad", {})), /bad turn/);
    const chunks: string[] = [];
    await settlesWithin(worker.runTurn("good", { onChunk: (text) => chunks.push(text) }));
    assert.deepEqual(chunks, ["recovered"]);
  } finally {
    await worker.dispose();
  }
});

test("AGY rejects an active turn on unexpected process exit with stderr", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.once("data",()=>{process.stderr.write("fatal detail"); process.exit(7)})`;
  const worker = createScriptedWorker(source);
  await worker.start();
  await assert.rejects(settlesWithin(worker.runTurn("hello", {})), /exited.*code 7.*fatal detail/i);
  await settlesWithin(worker.dispose());
});

test("AGY awaits callbacks in protocol order for the real tool event schema", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.once("data",()=>{for(const event of [{event:"step_update",step_update:{step_type:"thought",text_delta:"think"}},{event:"step_update",step_update:{step_type:"agent_response",text_delta:"answer"}},{event:"step_update",step_update:{step_type:"tool",step_index:4,state:"ACTIVE",tool_info:{tool_name:"read",parameters:{path:"a"}}}},{event:"step_update",step_update:{step_type:"tool",step_index:4,state:"DONE",tool_info:{tool_name:"read",output:"done"}}},{event:"result",result:{status:"SUCCESS",usage:{input_tokens:3,output_tokens:2,thinking_tokens:1,cache_read_tokens:4}}}]) console.log(JSON.stringify(event))})`;
  const worker = createScriptedWorker(source);
  const calls: string[] = [];
  const delayed = (value: string) => new Promise<void>((resolve) => setTimeout(() => { calls.push(value); resolve(); }, 5));
  try {
    await worker.start();
    await worker.runTurn("hello", {
      onThought: (text) => delayed(`thought:${text}`),
      onChunk: (text) => delayed(`chunk:${text}`),
      onToolStart: (id, name, input) => delayed(`start:${id}:${name}:${JSON.stringify(input)}`),
      onToolEnd: (id, output) => delayed(`end:${id}:${output}`),
      onMetrics: (metrics) => delayed(`metrics:${JSON.stringify(metrics)}`),
    });
    calls.push("resolved");
    assert.deepEqual(calls, [
      "thought:think", "chunk:answer", 'start:call_4:read:{"path":"a"}', "end:call_4:done",
      'metrics:{"inputTokens":3,"outputTokens":2,"thinkingTokens":1,"cachedTokens":4,"toolCalls":1}', "resolved",
    ]);
  } finally {
    await worker.dispose();
  }
});

test("AGY cancellation wins over a result callback already in flight", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.on("data",()=>console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"late"}}))); process.stdin.on("end",()=>setTimeout(()=>process.exit(0),250)); setInterval(()=>{},1000)`;
  const worker = createScriptedWorker(source);
  const controller = new AbortController();
  let entered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  try {
    await worker.start();
    const turn = worker.runTurn("hello", {
      onChunk: async () => {
        entered();
        await new Promise((resolve) => setTimeout(resolve, 100));
      },
    }, controller.signal);
    await callbackEntered;
    controller.abort();
    assert.equal((await settlesWithin(turn, 1_000)).cancelled, true);
  } finally {
    await worker.dispose();
  }
});

test("AGY rejects a turn when the child stdin pipe is already closed", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.resume()`;
  const worker = createScriptedWorker(source);
  try {
    await worker.start();
    const child = (worker as unknown as { child: { stdin: { destroy(): void } } }).child;
    child.stdin.destroy();
    await assert.rejects(settlesWithin(worker.runTurn("hello", {}), 500), /stdin|write/i);
  } finally {
    await worker.dispose();
  }
});

test("disposing during startup rejects the pending start even if init arrives late", async () => {
  const source = `setTimeout(()=>console.log(JSON.stringify({event:"init",conversation_id:"c"})),100); process.stdin.resume()`;
  const worker = createScriptedWorker(source);
  const start = worker.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const disposal = worker.dispose();
  await assert.rejects(settlesWithin(start), /disposed/i);
  await settlesWithin(disposal);
});

test("a cancelled worker cannot report itself ready again", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.resume()`;
  const worker = createScriptedWorker(source);
  await worker.start();
  const turn = worker.runTurn("hello", {});
  await worker.cancel();
  assert.equal((await settlesWithin(turn)).cancelled, true);
  await assert.rejects(worker.start(), /cancelled|stopped|terminal/i);
  await worker.dispose();
});

test("AGY rejects on process exit without waiting for inherited stdio to close", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.once("data",()=>{process.stderr.write("parent failed"); process.exit(7)})`;
  const worker = createScriptedWorker(source);
  await worker.start();
  const child = (worker as unknown as {
    child: { once(event: string, listener: (...args: any[]) => void): unknown; removeAllListeners(event: string): void };
  }).child;
  child.removeAllListeners("close");
  const originalOnce = child.once.bind(child);
  child.once = (event, listener) => event === "close" ? child : originalOnce(event, listener);
  await assert.rejects(settlesWithin(worker.runTurn("hello", {}), 300), /exited.*code 7/i);
  await worker.dispose();
});

test("AGY counts tools without display callbacks and reports metrics before error rejection", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.once("data",()=>{for(const event of [{event:"step_update",step_update:{step_type:"tool",step_index:2,state:"ACTIVE",tool_info:{tool_name:"read",parameters:{}}}},{event:"result",result:{status:"ERROR",error:"failed",usage:{input_tokens:5,output_tokens:1,thinking_tokens:2,cache_read_tokens:3}}}]) console.log(JSON.stringify(event))})`;
  const worker = createScriptedWorker(source);
  const metrics: unknown[] = [];
  try {
    await worker.start();
    await assert.rejects(worker.runTurn("hello", { onMetrics: (value) => metrics.push(value) }), /failed/);
    assert.deepEqual(metrics, [{ inputTokens: 5, outputTokens: 1, thinkingTokens: 2, cachedTokens: 3, toolCalls: 1 }]);
  } finally {
    await worker.dispose();
  }
});

test("aborting a turn settles it as cancelled without replaying the prompt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-worker-abort-"));
  const logPath = join(directory, "backend.log");
  const source = `const fs=require("node:fs"); console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.on("data",d=>fs.appendFileSync(process.env.LOG_PATH,d))`;
  const worker = createScriptedWorker(source, { env: { ...process.env, LOG_PATH: logPath } });
  const controller = new AbortController();
  try {
    await worker.start();
    const turn = worker.runTurn("once", {}, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort();
    assert.equal((await settlesWithin(turn)).cancelled, true);
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).message.content[0].text, "once");
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("dispose is idempotent and settles an active turn", async () => {
  const source = `console.log(JSON.stringify({event:"init",conversation_id:"c"})); process.stdin.resume()`;
  const worker = createScriptedWorker(source);
  await worker.start();
  const turn = worker.runTurn("hello", {});
  await settlesWithin(Promise.all([worker.dispose(), worker.dispose()]).then(() => undefined));
  assert.equal((await settlesWithin(turn)).cancelled, true);
  await settlesWithin(worker.dispose());
  await assert.rejects(worker.runTurn("later", {}), /disposed/);
});

test("AGY timing observes thought and text events without display callbacks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agy-worker-timing-"));
  const logPath = join(directory, "backend.log");
  const worker = createFixtureWorker(logPath);
  const writes: string[] = [];
  const trace = new TimingTrace("agy", "timing", { ACP_TIMING: "1" }, (line) => writes.push(line));
  try {
    await worker.start();
    await worker.runTurn("one", { trace });
    assert.match(writes.join(""), /mark=first_thought/);
    assert.match(writes.join(""), /mark=first_text/);
  } finally {
    await worker.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
