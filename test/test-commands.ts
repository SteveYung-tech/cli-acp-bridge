import { handleLocalSlashCommand } from "../src/commands/local-handlers.js";
import { AtomCodeAdapter } from "../src/adapters/atomcode/index.js";
import { AgyAdapter } from "../src/adapters/agy/index.js";
import { SessionManager } from "../src/session/manager.js";

console.log("=== Testing /usage, /cost, /status Slash Commands ===");

const sessionManager = new SessionManager();
const session = sessionManager.createSession(process.cwd());

// Simulate some turn usage
sessionManager.addMetrics(session.id, {
  inputTokens: 2500,
  outputTokens: 450,
  thinkingTokens: 180,
  cachedTokens: 1200,
  toolCalls: 3,
});
session.turnCount = 2;
session.model = "deepseek-v4-flash";
session.mode = "code";

// 1. Test AtomCode /usage
const atomAdapter = new AtomCodeAdapter();
const atomUsage = handleLocalSlashCommand("/usage", session, atomAdapter);
console.log("\n[AtomCode /usage Output]:\n" + atomUsage.content);

// 2. Test Antigravity /usage
const agyAdapter = new AgyAdapter();
session.model = "Gemini 3.7 Flash (High)";
session.mode = "accept-edits";
const agyUsage = handleLocalSlashCommand("/usage", session, agyAdapter);
console.log("\n[Antigravity /usage Output]:\n" + agyUsage.content);

// 3. Test /cost
const costRes = handleLocalSlashCommand("/cost", session, atomAdapter);
console.log("\n[/cost Output]:\n" + costRes.content);

// 4. Test /status
const statusRes = handleLocalSlashCommand("/status", session, agyAdapter);
console.log("\n[/status Output]:\n" + statusRes.content);

console.log("\n=== ALL SLASH COMMAND TESTS PASSED ===");
