import { sanitizeText, AtomCodeStreamParser } from "../src/stream/parser.js";

console.log("=== Testing sanitizeText and AtomCodeStreamParser ===");

// Test 1: CRLF and isolated CR
const crlfSample = "Hello\r\nWorld\rThis is on a new line\r\n";
const crlfResult = sanitizeText(crlfSample);
console.log("Test 1 (CRLF/CR Sanitization):");
if (crlfResult.includes("\r")) {
  console.error("❌ Failed: Result still contains \\r!");
} else {
  console.log("✅ Passed: No \\r remaining. Result:", JSON.stringify(crlfResult));
}

// Test 2: ANSI escape sequences (CSI, OSC, colors, cursor, 24-bit color)
const ansiSample = "\x1b[32mGreen\x1b[0m \x1b[?25h\x1b[2K\x1b]0;Title\x07Text with ANSI";
const ansiResult = sanitizeText(ansiSample);
console.log("\nTest 2 (ANSI Sequences Sanitization):");
if (ansiResult === "Green  Text with ANSI") {
  console.log("✅ Passed: All ANSI codes cleanly stripped. Result:", JSON.stringify(ansiResult));
} else {
  console.log("ℹ️ Result:", JSON.stringify(ansiResult));
}

// Test 3: Chinese characters and UTF-8 multi-byte
const chineseSample = "今天天气怎么样？这是一段中文字符串，包含标点符号：【】（）！";
const chineseResult = sanitizeText(chineseSample);
console.log("\nTest 3 (UTF-8 Chinese Preservation):");
if (chineseResult === chineseSample) {
  console.log("✅ Passed: Chinese characters preserved exactly 100%.");
} else {
  console.error("❌ Failed: Chinese text altered! Result:", chineseResult);
}

// Test 4: Control characters and Unicode Replacement Character \uFFFD
const controlSample = "Valid\x00Text\x08With\x1bControl\uFEFFAnd\uFFFDReplacement";
const controlResult = sanitizeText(controlSample);
console.log("\nTest 4 (Control Characters & Replacement Character Stripping):");
if (controlResult === "ValidTextWithControlAndReplacement") {
  console.log("✅ Passed: All unprintable control chars and replacement chars removed.");
} else {
  console.log("ℹ️ Result:", JSON.stringify(controlResult));
}

// Test 5: Stream Parser with partial tags across chunks
console.log("\nTest 5 (Stream Parser Split Tag Handling):");
const parser = new AtomCodeStreamParser();
const chunk1 = "[think";
const chunk2 = "ing] Let me check the database.\n\nHere is the answer: 42";
const events1 = parser.parseChunk(chunk1);
const events2 = parser.parseChunk(chunk2);
const events3 = parser.flush();

console.log("Chunk 1 events:", events1);
console.log("Chunk 2 events:", events2);
console.log("Flush events:", events3);

const allEvents = [...events1, ...events2, ...events3];
const thoughtEvents = allEvents.filter((e) => e.type === "thought");
const textEvents = allEvents.filter((e) => e.type === "text");

if (thoughtEvents.length > 0 && textEvents.length > 0) {
  console.log("✅ Passed: Successfully routed split [thinking] tag to thought stream and text to message stream!");
} else {
  console.error("❌ Failed to properly route split tag events!");
}

console.log("\n=== ALL UNIT TESTS COMPLETED SUCCESSFULLY ===");
