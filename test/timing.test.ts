import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { TimingTrace } from "../src/runtime/timing.js";

test("timing diagnostics are silent unless ACP_TIMING is enabled", () => {
  const writes: string[] = [];
  const trace = new TimingTrace("agy", "session-1", {}, (line) => writes.push(line));

  trace.mark("prompt_received");

  assert.deepEqual(writes, []);
});

test("timing diagnostics identify the adapter and session when enabled", () => {
  const writes: string[] = [];
  const trace = new TimingTrace("atomcode", "session-2", { ACP_TIMING: "1" }, (line) => writes.push(line));

  trace.mark("prompt_received");

  assert.equal(writes.length, 1);
  assert.match(writes[0]!, /adapter=atomcode/);
  assert.match(writes[0]!, /session=session-2/);
  assert.match(writes[0]!, /mark=prompt_received/);
  assert.match(writes[0]!, /elapsed_ms=\d+(?:\.\d+)?/);
});

test("enabled timing diagnostics use stderr and do not write ACP stdout", (t) => {
  const stderrWrites: string[] = [];
  const stdoutWrites: string[] = [];
  t.mock.method(process.stderr, "write", ((chunk: string) => {
    stderrWrites.push(chunk);
    return true;
  }) as typeof process.stderr.write);
  t.mock.method(process.stdout, "write", ((chunk: string) => {
    stdoutWrites.push(chunk);
    return true;
  }) as typeof process.stdout.write);

  new TimingTrace("agy", "session-stderr", { ACP_TIMING: "1" }).mark("prompt_received");

  assert.equal(stderrWrites.length, 1);
  assert.match(stderrWrites[0]!, /adapter=agy/);
  assert.match(stderrWrites[0]!, /session=session-stderr/);
  assert.deepEqual(stdoutWrites, []);
});

test("child traces preserve timing configuration and their shared monotonic baseline", (t) => {
  const ticks = [100, 105, 112];
  const writes: string[] = [];
  t.mock.method(performance, "now", () => ticks.shift()!);

  const trace = new TimingTrace("agy", "session-child", { ACP_TIMING: "1" }, (line) => writes.push(line));
  trace.mark("parent_mark");
  trace.child("transport").mark("child_mark");

  assert.deepEqual(writes, [
    "acp_timing adapter=agy session=session-child trace=root mark=parent_mark elapsed_ms=5.000\n",
    "acp_timing adapter=agy session=session-child trace=root.transport mark=child_mark elapsed_ms=12.000\n",
  ]);
});

test("disabled child traces keep their inherited writer silent", () => {
  const writes: string[] = [];
  const trace = new TimingTrace("atomcode", "session-disabled", {}, (line) => writes.push(line));

  trace.child("transport").mark("request_started");

  assert.deepEqual(writes, []);
});
