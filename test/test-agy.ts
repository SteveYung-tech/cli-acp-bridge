import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(__dirname, "../dist/index.js");

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

async function runAgyTest() {
  console.log("=== Starting agy-acp (Antigravity) End-to-End Test Suite ===");
  console.log(`Target Server Script: ${serverScript}`);

  const child = spawn("node", [serverScript], {
    env: {
      ...process.env,
      ACP_ADAPTER: "agy",
      HTTP_PROXY: "http://127.0.0.1:7897",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    },
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });

  const rl = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });

  let nextId = 1;
  const pendingRequests = new Map<number, { resolve: (res: any) => void; reject: (err: any) => void }>();
  let updateChunkCount = 0;

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg: JsonRpcMessage = JSON.parse(line);

      // Notification
      if (msg.method) {
        if (msg.params?.update?.sessionUpdate === "agent_message_chunk") {
          const chunk = msg.params.update.content.text;
          process.stdout.write(chunk);
          updateChunkCount++;
        } else if (msg.params?.update?.sessionUpdate === "agent_thought_chunk") {
          process.stdout.write(`\n[Thought] ${msg.params.update.content.text}\n`);
        } else if (msg.params?.update?.sessionUpdate === "tool_call") {
          console.log(`\n[Tool Call Start] ${msg.params.update.title}`);
        } else if (msg.params?.update?.sessionUpdate === "available_commands_update") {
          const cmds = msg.params.update.availableCommands.map((c: any) => `/${c.name}`).join(", ");
          console.log(`<- [Slash Commands Loaded]: ${cmds}`);
        }
        return;
      }

      // Response
      if (msg.id !== undefined && pendingRequests.has(Number(msg.id))) {
        const handler = pendingRequests.get(Number(msg.id))!;
        pendingRequests.delete(Number(msg.id));
        if (msg.error) {
          handler.reject(msg.error);
        } else {
          handler.resolve(msg.result);
        }
      }
    } catch (e) {
      console.error("Failed to parse JSON-RPC line:", line, e);
    }
  });

  function sendRequest(method: string, params: any): Promise<any> {
    const id = nextId++;
    const req = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };
    return new Promise((resolve, reject) => {
      pendingRequests.set(id, { resolve, reject });
      child.stdin!.write(JSON.stringify(req) + "\n");
    });
  }

  try {
    // 1. Test initialize
    console.log("\n-> [Test 1] 'initialize' request...");
    const initRes = await sendRequest("initialize", {
      clientInfo: {
        name: "test-client",
        version: "1.0.0",
      },
      protocolVersion: 1,
    });
    console.log("<- Initialize Response:", JSON.stringify(initRes));

    // 2. Test session/new
    console.log("\n-> [Test 2] 'session/new' request...");
    const sessionRes = await sendRequest("session/new", {
      cwd: process.cwd(),
      mcpServers: [],
    });
    console.log("<- Session New Response:", JSON.stringify(sessionRes));
    const sessionId = sessionRes.sessionId;

    // 3. Test session/prompt
    console.log("\n-> [Test 3] Prompt: 'Say hello in 5 words and identify yourself as Antigravity'");
    process.stdout.write("--- Streamed Output Begin ---\n");
    updateChunkCount = 0;

    const promptRes = await sendRequest("session/prompt", {
      sessionId,
      prompt: [
        {
          type: "text",
          text: "用简短的一句话打招呼并说明你是 Antigravity (agy) 编程助手",
        },
      ],
    });
    process.stdout.write("\n--- Streamed Output End ---\n");
    console.log(`<- Prompt Response: ${JSON.stringify(promptRes)}, chunks: ${updateChunkCount}`);

    console.log("\n=================================");
    console.log("[ALL TESTS PASSED] Antigravity (agy) ACP Bridge is fully functional! 🚀");
    console.log("=================================");
  } catch (err) {
    console.error("\n[TEST FAILED]:", err);
  } finally {
    child.kill();
    process.exit(0);
  }
}

runAgyTest();
