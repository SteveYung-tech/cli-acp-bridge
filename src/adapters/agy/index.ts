import fs from "node:fs";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter, ExecuteTurnOptions, TurnResult } from "../base.js";
import type { SessionState } from "../../session/manager.js";
import { processCommandWithPrefix, type ProcessCommand } from "../../runtime/process-command.js";
import { TimingTrace } from "../../runtime/timing.js";
import { AgyWorker } from "./worker.js";

const DEFAULT_AGY_MODEL = "Gemini 3.7 Flash (High)";
const DEFAULT_AGY_MODE = "accept-edits";

export interface AgyAdapterOptions {
  command?: ProcessCommand;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

interface AgySessionRuntime {
  worker: AgyWorker;
  preparation: Promise<void>;
  cwd: string;
  model: string;
  mode: string;
  conversationId?: string;
}

export class AgyAdapter implements AgentAdapter {
  public readonly id = "agy";
  public readonly name = "Antigravity";
  public readonly defaultBinaryName = "agy";
  public readonly binaryEnvVar = "AGY_PATH";

  private readonly runtimes = new Map<string, AgySessionRuntime>();
  private disposed = false;

  public constructor(private readonly options: AgyAdapterOptions = {}) {}

  public async start(): Promise<void> {
    if (this.disposed) throw new Error("AGY adapter is disposed");
  }

  public createSession(session: SessionState): void {
    if (this.disposed) throw new Error("AGY adapter is disposed");
    if (this.runtimes.has(session.id)) return;
    this.runtimes.set(session.id, this.createRuntime(session));
  }

  public async updateSession(session: SessionState): Promise<void> {
    if (this.disposed) throw new Error("AGY adapter is disposed");
    const current = this.runtimes.get(session.id);
    if (!current) {
      const created = this.createRuntime(session);
      this.runtimes.set(session.id, created);
      await created.preparation;
      return;
    }

    const model = session.model ?? DEFAULT_AGY_MODEL;
    const mode = session.mode ?? DEFAULT_AGY_MODE;
    if (current.model === model && current.mode === mode) {
      await current.preparation;
      return;
    }

    const conversationId = current.worker.used
      ? current.worker.conversationId ?? current.conversationId
      : current.conversationId;
    await current.worker.dispose();
    const replacement = this.createRuntime(session, conversationId);
    this.runtimes.set(session.id, replacement);
    await replacement.preparation;
  }

  public async cancelTurn(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    await runtime.preparation;
    if (!runtime.worker.hasActiveTurn) return;
    await runtime.worker.cancel();
    runtime.conversationId = runtime.worker.conversationId ?? runtime.conversationId;
    if (!this.disposed && this.runtimes.get(sessionId) === runtime) {
      const replacement = this.createRuntimeFromConfig(
        runtime.cwd,
        runtime.model,
        runtime.mode,
        runtime.conversationId,
      );
      this.runtimes.set(sessionId, replacement);
      await replacement.preparation;
    }
  }

  public async closeSession(sessionId: string): Promise<void> {
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) return;
    this.runtimes.delete(sessionId);
    await runtime.worker.dispose();
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(runtimes.map((runtime) => runtime.worker.dispose()));
  }

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
    if (this.disposed) throw new Error("AGY adapter is disposed");
    const runtime = this.runtimes.get(options.sessionId);
    if (!runtime) throw new Error(`Unknown or closed AGY ACP session: ${options.sessionId}`);

    await runtime.preparation;
    const trace = options.trace ?? new TimingTrace("agy", options.sessionId, this.options.env ?? process.env);
    if (!options.trace) trace.mark("prompt_received");
    const result = await runtime.worker.runTurn(options.prompt, {
      onThought: options.onThought,
      onChunk: options.onChunk,
      onToolStart: options.onToolStart,
      onToolEnd: options.onToolEnd,
      onMetrics: options.onMetrics,
      onStderr: options.onStderr,
      trace,
    }, options.signal);
    runtime.conversationId = runtime.worker.conversationId ?? runtime.conversationId;
    return result;
  }

  private createRuntime(session: SessionState, conversationId?: string): AgySessionRuntime {
    const model = session.model ?? DEFAULT_AGY_MODEL;
    const mode = session.mode ?? DEFAULT_AGY_MODE;
    return this.createRuntimeFromConfig(session.cwd, model, mode, conversationId);
  }

  private createRuntimeFromConfig(
    cwd: string,
    model: string,
    mode: string,
    conversationId?: string,
  ): AgySessionRuntime {
    const worker = new AgyWorker({
      command: this.options.command ?? processCommandWithPrefix(
        this.resolveBinaryPath(),
        "AGY_ARGS_PREFIX_JSON",
        this.options.env ?? process.env,
      ),
      cwd,
      model,
      mode,
      conversationId,
      env: this.createEnvironment(),
      startupTimeoutMs: this.options.startupTimeoutMs,
    });
    const preparation = worker.start();
    void preparation.catch(() => undefined);
    return {
      worker,
      preparation,
      cwd,
      model,
      mode,
      conversationId,
    };
  }

  private createEnvironment(): NodeJS.ProcessEnv {
    const env = { ...(this.options.env ?? process.env) };
    const proxyUrl =
      env.HTTPS_PROXY ||
      env.HTTP_PROXY ||
      env.https_proxy ||
      env.http_proxy ||
      env.ALL_PROXY ||
      "http://127.0.0.1:7897";
    return {
      ...env,
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      ALL_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      all_proxy: proxyUrl,
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
