import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../base.js";
import type { SessionState } from "../../session/manager.js";
import type { ProcessCommand } from "../../runtime/process-command.js";
import {
  AtomCodeDaemon,
  type AtomCodeChatEvent,
  type AtomCodeDaemonOptions,
  type AtomCodeSession,
} from "./daemon.js";

const DEFAULT_ATOMCODE_MODEL = "deepseek-v4-flash";
const DEFAULT_ATOMCODE_MODE = "code";

export interface AtomCodeAdapterOptions {
  command?: ProcessCommand;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

interface AtomCodeSessionRuntime {
  preparation: Promise<AtomCodeSession>;
  cwd: string;
  nativeSessionId?: string;
  activeRequestId?: string;
  cancelTarget?: string;
  cancelRequested: boolean;
  turnPending: boolean;
  closed: boolean;
}

export class AtomCodeAdapter implements AgentAdapter {
  public readonly id = "atomcode";
  public readonly name = "AtomCode";
  public readonly defaultBinaryName = "atomcode";
  public readonly binaryEnvVar = "ATOMCODE_PATH";

  private readonly daemon: AtomCodeDaemon;
  private readonly runtimes = new Map<string, AtomCodeSessionRuntime>();
  private startPromise?: Promise<void>;
  private disposed = false;

  public constructor(private readonly options: AtomCodeAdapterOptions = {}) {
    const daemonOptions: AtomCodeDaemonOptions = {
      command: options.command ?? { command: this.resolveBinaryPath(), argsPrefix: [] },
      env: this.createEnvironment(),
      startupTimeoutMs: options.startupTimeoutMs,
    };
    this.daemon = new AtomCodeDaemon(daemonOptions);
  }

  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AtomCode adapter is disposed"));
    if (!this.startPromise) {
      this.startPromise = this.daemon.start();
      void this.startPromise.catch(() => undefined);
    }
    return this.startPromise;
  }

  public createSession(session: SessionState): void {
    if (this.disposed) throw new Error("AtomCode adapter is disposed");
    if (this.runtimes.has(session.id)) return;
    const runtime: AtomCodeSessionRuntime = {
      cwd: session.cwd,
      cancelRequested: false,
      turnPending: false,
      closed: false,
      preparation: Promise.resolve(undefined as unknown as AtomCodeSession),
    };
    runtime.preparation = this.start()
      .then(() => this.daemon.createSession(session.cwd))
      .then((native) => {
        runtime.nativeSessionId = native.id;
        return native;
      });
    void runtime.preparation.catch(() => undefined);
    this.runtimes.set(session.id, runtime);
  }

  public async updateSession(session: SessionState): Promise<void> {
    const runtime = this.runtimes.get(session.id);
    if (!runtime) {
      this.createSession(session);
      await this.runtimes.get(session.id)!.preparation;
      return;
    }
    await runtime.preparation;
  }

  public async cancelTurn(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime?.activeRequestId) return;
    runtime.cancelRequested = true;
    await this.daemon.stop(runtime.cancelTarget ?? runtime.activeRequestId);
  }

  public async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    runtime.closed = true;
    if (runtime.activeRequestId) await this.cancelTurn(sessionId);
    this.runtimes.delete(sessionId);
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.runtimes.clear();
    await this.daemon.dispose();
  }

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
        currentValue: session.model || DEFAULT_ATOMCODE_MODEL,
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
        currentValue: session.mode || DEFAULT_ATOMCODE_MODE,
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
    if (this.disposed) throw new Error("AtomCode adapter is disposed");
    const runtime = this.runtimes.get(options.sessionId);
    if (!runtime) throw new Error(`Unknown or closed AtomCode ACP session: ${options.sessionId}`);
    if (runtime.closed) throw new Error(`Closed AtomCode ACP session: ${options.sessionId}`);
    if (runtime.turnPending || runtime.activeRequestId) {
      throw new Error("An AtomCode turn is already active for this ACP session");
    }
    if (options.signal?.aborted) {
      return { exitCode: null, stdout: "", stderr: "", cancelled: true };
    }

    runtime.turnPending = true;
    let native: AtomCodeSession;
    try {
      native = await runtime.preparation;
    } catch (error) {
      runtime.turnPending = false;
      throw error;
    }
    runtime.turnPending = false;
    if (runtime.closed || this.runtimes.get(options.sessionId) !== runtime) {
      throw new Error(`Closed AtomCode ACP session: ${options.sessionId}`);
    }
    if (runtime.activeRequestId) throw new Error("An AtomCode turn is already active for this ACP session");
    const requestId = crypto.randomUUID();
    runtime.activeRequestId = requestId;
    runtime.cancelTarget = requestId;
    runtime.cancelRequested = false;
    let terminal: "done" | "stopped" | undefined;
    let textOutput = "";
    let toolCalls = 0;
    const abortListener = () => void this.cancelTurn(options.sessionId).catch(() => undefined);
    options.signal?.addEventListener("abort", abortListener, { once: true });

    try {
      await this.daemon.chat({
        message: options.prompt,
        working_dir: options.cwd ?? runtime.cwd,
        session_id: native.id,
        request_id: requestId,
        provider: options.model ?? options.provider ?? DEFAULT_ATOMCODE_MODEL,
      }, async (event) => {
        if (event.type === "session_assigned" && typeof event.session_id === "string") {
          runtime.nativeSessionId = event.session_id;
          runtime.cancelTarget = event.session_id;
          return;
        }
        if (event.type === "error") {
          throw new Error(this.eventString(event.message ?? event.error, "AtomCode returned an error"));
        }
        if (event.type === "stopped") {
          terminal = "stopped";
          runtime.cancelRequested = true;
          return;
        }
        if (event.type === "done") {
          terminal = "done";
          if (!runtime.cancelRequested && options.onMetrics) {
            await options.onMetrics({
              toolCalls: typeof event.tool_calls === "number" ? event.tool_calls : toolCalls,
            });
          }
          return;
        }
        if (runtime.cancelRequested) return;
        await this.forwardEvent(event, options, () => { toolCalls++; }, (text) => { textOutput += text; });
      }, options.signal);

      if (runtime.cancelRequested || terminal === "stopped") {
        return { exitCode: null, stdout: textOutput, stderr: "", cancelled: true };
      }
      if (terminal !== "done") throw new Error("AtomCode chat stream ended without a terminal event");
      return { exitCode: null, stdout: textOutput, stderr: "", cancelled: false };
    } catch (error) {
      if (runtime.cancelRequested || options.signal?.aborted) {
        return { exitCode: null, stdout: textOutput, stderr: "", cancelled: true };
      }
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
      if (runtime.activeRequestId === requestId) {
        runtime.activeRequestId = undefined;
        runtime.cancelTarget = undefined;
        runtime.cancelRequested = false;
      }
    }
  }

  private async forwardEvent(
    event: AtomCodeChatEvent,
    options: ExecuteTurnOptions,
    countTool: () => void,
    appendText: (text: string) => void,
  ): Promise<void> {
    if (event.type === "text" && typeof event.content === "string") {
      appendText(event.content);
      await options.onChunk?.(event.content);
    } else if (event.type === "reasoning" && typeof event.content === "string") {
      await options.onThought?.(event.content);
    } else if (event.type === "tool_start" && typeof event.id === "string") {
      countTool();
      await options.onToolStart?.(
        event.id,
        typeof event.name === "string" ? event.name : "Tool",
        this.parseToolArguments(event.arguments),
      );
    } else if (event.type === "tool_result" && typeof event.id === "string") {
      await options.onToolEnd?.(event.id, this.eventString(event.output, "ok"));
    } else if (event.type === "tokens") {
      await options.onMetrics?.({
        inputTokens: typeof event.prompt === "number" ? event.prompt : undefined,
        outputTokens: typeof event.completion === "number" ? event.completion : undefined,
      });
    }
  }

  private parseToolArguments(value: unknown): unknown {
    if (typeof value !== "string") return value ?? {};
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private eventString(value: unknown, fallback: string): string {
    if (typeof value === "string") return value;
    if (value === undefined || value === null) return fallback;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private createEnvironment(): NodeJS.ProcessEnv {
    return {
      ...(this.options.env ?? process.env),
      CI: "true",
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
      LANG: "zh_CN.UTF-8",
      LC_ALL: "zh_CN.UTF-8",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
    };
  }
}
