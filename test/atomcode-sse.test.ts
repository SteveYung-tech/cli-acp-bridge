import assert from "node:assert/strict";
import test from "node:test";
import { SseParser } from "../src/adapters/atomcode/sse.js";

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

test("SSE parser joins data lines and ignores comments and event metadata", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push(": keepalive\r\nevent: message\r\ndata: first\r\ndata: second\r\n\r\n"), [
    "first\nsecond",
  ]);
});

test("SSE parser flushes one incomplete final frame only at finish", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: final"), []);
  assert.deepEqual(parser.finish(), ["final"]);
  assert.deepEqual(parser.finish(), []);
});
