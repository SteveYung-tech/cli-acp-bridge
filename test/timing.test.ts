import assert from "node:assert/strict";
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
