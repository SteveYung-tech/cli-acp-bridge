import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../base.js";
import type { SessionState } from "../../session/manager.js";

export class AgyAdapter implements AgentAdapter {
  public readonly id = "agy";
  public readonly name = "Antigravity";
  public readonly defaultBinaryName = "agy";
  public readonly binaryEnvVar = "AGY_PATH";

  public resolveBinaryPath(): string {
    if (process.env[this.binaryEnvVar] && fs.existsSync(process.env[this.binaryEnvVar]!)) {
      return process.env[this.binaryEnvVar]!;
    }

    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
      if (localAppData) {
        const standardPath = path.join(localAppData, "agy", "bin", "agy.exe");
        if (fs.existsSync(standardPath)) {
          return standardPath;
        }
      }
    } else {
      const home = process.env.HOME || "";
      const linuxCandidates = [
        path.join(home, ".local", "bin", "agy"),
        path.join(home, ".gemini", "antigravity-cli", "bin", "agy"),
        path.join(home, ".gemini", "bin", "agy"),
        path.join(home, "bin", "agy"),
        "/usr/local/bin/agy",
        "/usr/bin/agy",
      ];
      for (const candidate of linuxCandidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return process.platform === "win32" ? "agy.exe" : "agy";
  }

  public getAvailableConfigOptions(session: SessionState): acp.SessionConfigOption[] {
    return [
      {
        id: "model",
        name: "Model",
        description: "Select LLM model for Antigravity (AGY)",
        type: "select",
        currentValue: session.model || "Gemini 3.7 Flash (High)",
        options: [
          { value: "Gemini 3.7 Flash (High)", name: "Gemini 3.7 Flash (High)" },
          { value: "Gemini 3.7 Flash (Medium)", name: "Gemini 3.7 Flash (Medium)" },
          { value: "Gemini 3.7 Flash (Low)", name: "Gemini 3.7 Flash (Low)" },
          { value: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
          { value: "Claude Sonnet 4.6 (Thinking)", name: "Claude Sonnet 4.6 (Thinking)" },
          { value: "Claude Opus 4.6 (Thinking)", name: "Claude Opus 4.6 (Thinking)" },
          { value: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)" },
        ],
      },
      {
        id: "mode",
        name: "Mode",
        description: "Select agent execution mode",
        type: "select",
        currentValue: session.mode || "accept-edits",
        options: [
          { value: "accept-edits", name: "Accept Edits (Code Execution)" },
          { value: "plan", name: "Plan (Architect / Read-only)" },
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
        description: "Analyze git diff and create a Conventional Commit (分析代码变更并自动提交 Git Commit)",
        input: { hint: "可选：补充提交重点/说明，留空则自动分析生成规范提交..." },
      },
      {
        name: "cost",
        description: "Show token consumption, breakdown, and estimated costs (查看 Token 消耗与用量统计)",
        input: null,
      },
      {
        name: "plan",
        description: "Create comprehensive architectural design and execution plan (创建高层次架构设计与分步规划)",
        input: { hint: "输入你要规划的系统设计或功能目标..." },
      },
      {
        name: "review",
        description: "Review workspace code changes and git diff (深度审查工作区代码与 Git 差异)",
        input: { hint: "可选：指定审查重点或留空审查全部变更..." },
      },
      {
        name: "review-branch",
        description: "Review all changes against the base branch (审查当前分支与主分支差异)",
        input: { hint: "输入对比的基础分支名 (如 main / dev)..." },
      },
      {
        name: "grill-me",
        description: "Interactive design interview to clarify decisions (通过交互式问答深度对齐方案与决策)",
        input: { hint: "输入要对齐的方案或疑难问题..." },
      },
      {
        name: "learn",
        description: "Persist session knowledge, guidelines, and rules (将当前上下文与规范沉淀为知识库)",
        input: { hint: "输入需要沉淀的规则或项目约定..." },
      },
      {
        name: "research",
        description: "Spawn read-only research subagents to explore codebase & docs (启动调研子代理深度探索代码库)",
        input: { hint: "输入调研课题或要探索的技术点..." },
      },
      {
        name: "compact",
        description: "Compact conversation context and retain key memory (压缩上下文并保留核心记忆)",
        input: null,
      },
      {
        name: "mcp",
        description: "List configured Model Context Protocol (MCP) servers and tools (查看 MCP 工具生态)",
        input: null,
      },
      {
        name: "skills",
        description: "List available skills and specialized capabilities (查看可用技能与能力集)",
        input: null,
      },
      {
        name: "help",
        description: "Show Antigravity guide and available capabilities (查看指南与全部能力)",
        input: null,
      },
    ];
  }

  public async executeTurn(options: ExecuteTurnOptions): Promise<TurnResult> {
    const binaryPath = this.resolveBinaryPath();
    const args: string[] = [];

    // Working directory
    if (options.cwd) {
      args.push("--add-dir", options.cwd);
    }

    // Continue session
    if (options.continueSession) {
      args.push("-c");
    }

    // Model and Mode
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.mode) {
      args.push("--mode", options.mode);
    }

    // Single turn print with stream-json format
    args.push("-p", options.prompt);
    args.push("--output-format", "stream-json");
    args.push("--dangerously-skip-permissions");

    // Default Proxy fallback
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.https_proxy ||
      process.env.http_proxy ||
      process.env.ALL_PROXY ||
      "http://127.0.0.1:7897";

    return new Promise((resolve, reject) => {
      let stdoutData = "";
      let stderrData = "";
      let isCancelled = false;
      let lineBuffer = "";
      let streamedAnyText = false;
      let agyErrorMessage: string | null = null;

      const child: ChildProcess = spawn(binaryPath, args, {
        cwd: options.cwd || process.cwd(),
        env: {
          ...process.env,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          https_proxy: proxyUrl,
          all_proxy: proxyUrl,
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
          console.error("Error killing agy process:", err);
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

      const processJsonLine = async (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;

        try {
          const data = JSON.parse(trimmed);

          // 1. Step updates
          if (data.event === "step_update" && data.step_update) {
            const update = data.step_update;

            if (update.usage && options.onMetrics) {
              await options.onMetrics({
                inputTokens: update.usage.input_tokens || 0,
                outputTokens: update.usage.output_tokens || 0,
                thinkingTokens: update.usage.thinking_tokens || 0,
                cachedTokens: update.usage.cache_read_tokens || 0,
              });
            }

            if (update.step_type === "agent_response" && update.text_delta && options.onChunk) {
              streamedAnyText = true;
              await options.onChunk(update.text_delta);
            } else if (update.step_type === "thought" && update.text_delta && options.onThought) {
              await options.onThought(update.text_delta);
            } else if (update.step_type === "tool_call" && options.onToolStart) {
              if (options.onMetrics) {
                await options.onMetrics({ toolCalls: 1 });
              }
              const toolCallId = `call_${update.step_index || Date.now()}`;
              await options.onToolStart(toolCallId, update.tool_name || "Tool", update.input || {});
            } else if (update.step_type === "tool_result" && options.onToolEnd) {
              const toolCallId = `call_${update.step_index || Date.now()}`;
              await options.onToolEnd(toolCallId, update.output || "ok");
            }
          } else if (data.event === "result" && data.result) {
            if (data.result.usage && options.onMetrics) {
              await options.onMetrics({
                inputTokens: data.result.usage.input_tokens || 0,
                outputTokens: data.result.usage.output_tokens || 0,
                thinkingTokens: data.result.usage.thinking_tokens || 0,
                cachedTokens: data.result.usage.cache_read_tokens || 0,
              });
            }
            if (data.result.status === "ERROR") {
              agyErrorMessage = data.result.error || "AGY returned an error";
            } else if (!streamedAnyText && data.result.response && options.onChunk) {
              await options.onChunk(data.result.response);
              streamedAnyText = true;
            }
          }
        } catch {
          // Non-JSON line fallback
          if (options.onChunk && !trimmed.startsWith("Fetching") && !trimmed.startsWith("Checking")) {
            await options.onChunk(line + "\n");
          }
        }
      };

      const stdoutDecoder = new StringDecoder("utf-8");
      const stderrDecoder = new StringDecoder("utf-8");

      if (child.stdout) {
        child.stdout.on("data", async (chunk: Buffer) => {
          const raw = stdoutDecoder.write(chunk);
          if (!raw) return;
          stdoutData += raw;
          lineBuffer += raw;

          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() || "";

          for (const line of lines) {
            await processJsonLine(line);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (chunk: Buffer) => {
          const raw = stderrDecoder.write(chunk);
          if (!raw) return;
          stderrData += raw;
          if (options.onStderr) {
            options.onStderr(raw);
          }
        });
      }

      child.on("error", (err: Error) => {
        cleanup();
        reject(new Error(`Failed to spawn Antigravity CLI (${binaryPath}): ${err.message}`));
      });

      child.on("close", async (code: number | null) => {
        cleanup();
        const finalStdout = stdoutDecoder.end();
        if (finalStdout) {
          stdoutData += finalStdout;
          lineBuffer += finalStdout;
        }
        if (lineBuffer.trim().length > 0) {
          await processJsonLine(lineBuffer);
          lineBuffer = "";
        }

        if (code !== 0 && !isCancelled) {
          reject(new Error(agyErrorMessage || stderrData || `AGY process exited with code ${code}`));
          return;
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
