import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../base.js";
import type { SessionState } from "../../session/manager.js";
import { AtomCodeStreamParser } from "../../stream/parser.js";

export class AtomCodeAdapter implements AgentAdapter {
  public readonly id = "atomcode";
  public readonly name = "AtomCode";
  public readonly defaultBinaryName = "atomcode";
  public readonly binaryEnvVar = "ATOMCODE_PATH";

  public resolveBinaryPath(): string {
    if (process.env[this.binaryEnvVar] && fs.existsSync(process.env[this.binaryEnvVar]!)) {
      return process.env[this.binaryEnvVar]!;
    }

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
      if (localAppData) {
        const standardPath = path.join(localAppData, "AtomCode", "atomcode.exe");
        if (fs.existsSync(standardPath)) {
          return standardPath;
        }
      }
    } else {
      const home = process.env.HOME || "";
      const linuxCandidates = [
        path.join(home, ".local", "bin", "atomcode"),
        path.join(home, "bin", "atomcode"),
        "/usr/local/bin/atomcode",
        "/usr/bin/atomcode",
      ];
      for (const candidate of linuxCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return process.platform === "win32" ? "atomcode.exe" : "atomcode";
  }

  public getAvailableConfigOptions(session: SessionState): acp.SessionConfigOption[] {
    return [
      {
        id: "model",
        name: "Model",
        description: "Select LLM model for AtomCode",
        type: "select",
        currentValue: session.model || "deepseek-v4-flash",
        options: [
          { value: "deepseek-v4-flash", name: "DeepSeek V4 Flash (Default)" },
          { value: "deepseek-v4", name: "DeepSeek V4" },
          { value: "codingplan-deepseek", name: "CodingPlan DeepSeek" },
          { value: "qwen-2.5-coder-32b", name: "Qwen 2.5 Coder 32B" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        description: "Select agent operating mode",
        type: "select",
        currentValue: session.mode || "code",
        options: [
          { value: "code", name: "Code (Agentic Coding)" },
          { value: "architect", name: "Architect (Planning)" },
          { value: "ask", name: "Ask (Explanation / Q&A)" },
        ],
      },
    ];
  }

  public getAvailableCommands(_session: SessionState): acp.AvailableCommand[] {
    return [
      {
        name: "usage",
        description: "Display quota limit, token usage, and session metrics (查询额度与用量统计)",
        input: null,
      },
      {
        name: "commit",
        description: "Analyze git diff and create a Conventional Commit (分析变更并自动提交 Git Commit)",
        input: { hint: "可选：补充提交重点/说明，留空则自动分析生成规范提交..." },
      },
      {
        name: "cost",
        description: "Show token usage breakdown and costs (查看当前会话 Token 消耗与成本)",
        input: null,
      },
      {
        name: "review",
        description: "Review uncommitted changes and code quality (审查当前代码变更与质量)",
        input: { hint: "可选：指定要审查的文件或模块，留空审查全部变更..." },
      },
      {
        name: "plan",
        description: "Create step-by-step implementation plan before coding (制定分步编码任务计划)",
        input: { hint: "输入需要规划的功能或任务需求..." },
      },
      {
        name: "compact",
        description: "Summarize conversation to avoid hitting context limit (压缩会话历史以释放上下文)",
        input: null,
      },
      {
        name: "mcp",
        description: "List configured Model Context Protocol (MCP) tools (列出已加载的 MCP 工具)",
        input: null,
      },
      {
        name: "skills",
        description: "List available skills and custom workflows (列出已配置的技能与工作流)",
        input: null,
      },
      {
        name: "init",
        description: "Analyze workspace structure and initialize project rules (分析项目结构并初始化规范)",
        input: { hint: "可选：指定项目类型或规范要求..." },
      },
      {
        name: "help",
        description: "Show help and all available commands (查看帮助与指令说明)",
        input: null,
      },
    ];
  }

  public async executeTurn(options: ExecuteTurnOptions): Promise<TurnResult> {
    const binaryPath = this.resolveBinaryPath();
    const args: string[] = [];

    if (options.continueSession) {
      args.push("-c");
    }

    if (options.cwd) {
      args.push("-C", options.cwd);
    }

    if (options.model) {
      args.push("--model", options.model);
    }

    if (options.provider) {
      args.push("--provider", options.provider);
    }

    args.push("-p", options.prompt);
    args.push("-y");
    args.push("-v");
    args.push("--dev");
    args.push("--no-telemetry");

    const streamParser = new AtomCodeStreamParser();

    return new Promise((resolve, reject) => {
      let stdoutData = "";
      let stderrData = "";
      let isCancelled = false;

      const child: ChildProcess = spawn(binaryPath, args, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          CI: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });

      const cleanup = () => {
        if (options.signal) {
          options.signal.removeEventListener("abort", onAbort);
        }
      };

      const onAbort = () => {
        isCancelled = true;
        try {
          if (child.pid) {
            if (process.platform === "win32") {
              spawn("taskkill", ["/pid", child.pid.toString(), "/f", "/t"]);
            } else {
              child.kill("SIGTERM");
            }
          }
        } catch (err) {
          console.error("Error killing AtomCode process:", err);
        }
      };

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          cleanup();
          return resolve({
            exitCode: null,
            stdout: "",
            stderr: "",
            cancelled: true,
          });
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      const handleEvent = async (event: ReturnType<typeof streamParser.parseChunk>[0]) => {
        if (event.type === "thought" && event.content && options.onThought) {
          await options.onThought(event.content);
        } else if (event.type === "tool_call_start" && event.toolCallId && options.onToolStart) {
          if (options.onMetrics) {
            await options.onMetrics({ toolCalls: 1 });
          }
          await options.onToolStart(event.toolCallId, event.toolName || "Tool", event.toolInput);
        } else if (event.type === "tool_call_end" && event.toolCallId && options.onToolEnd) {
          await options.onToolEnd(event.toolCallId, event.toolResult || "ok");
        } else if (event.type === "tokens" && event.metrics && options.onMetrics) {
          await options.onMetrics(event.metrics);
        } else if (event.type === "text" && event.content && options.onChunk) {
          await options.onChunk(event.content);
        }
      };

      const stdoutDecoder = new StringDecoder("utf-8");
      const stderrDecoder = new StringDecoder("utf-8");

      if (child.stdout) {
        child.stdout.on("data", async (chunk: Buffer) => {
          const raw = stdoutDecoder.write(chunk);
          if (!raw) return;
          stdoutData += raw;
          const events = streamParser.parseChunk(raw);
          for (const ev of events) {
            await handleEvent(ev);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", async (chunk: Buffer) => {
          const raw = stderrDecoder.write(chunk);
          if (!raw) return;
          stderrData += raw;
          const events = streamParser.parseChunk(raw);
          for (const ev of events) {
            await handleEvent(ev);
          }
        });
      }

      child.on("error", (err: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn AtomCode CLI (${binaryPath}): ${err.message}`));
      });

      child.on("close", async (code: number | null) => {
        cleanup();
        const finalStdout = stdoutDecoder.end();
        if (finalStdout) {
          stdoutData += finalStdout;
          const events = streamParser.parseChunk(finalStdout);
          for (const ev of events) {
            await handleEvent(ev);
          }
        }
        const remaining = streamParser.flush();
        for (const ev of remaining) {
          await handleEvent(ev);
        }

        resolve({
          exitCode: code,
          stdout: stdoutData,
          stderr: stderrData,
          cancelled: isCancelled,
        });
      });
    });
  }
}
