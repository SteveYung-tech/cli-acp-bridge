import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExecuteTurnOptions, TurnResult } from "../base.js";
import { sanitizeText } from "../../stream/parser.js";
import { spawnCommand, terminateProcess, type ProcessCommand } from "../../runtime/process-command.js";
import { TimingTrace } from "../../runtime/timing.js";

export interface AgyWorkerOptions {
  command: ProcessCommand;
  cwd: string;
  model?: string;
  mode?: string;
  conversationId?: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
}

export type AgyTurnCallbacks = Pick<
  ExecuteTurnOptions,
  "onThought" | "onChunk" | "onToolStart" | "onToolEnd" | "onMetrics" | "onStderr" | "trace"
>;

interface ActiveTurn {
  callbacks: AgyTurnCallbacks;
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  stdout: string;
  stderr: string;
  streamedText: boolean;
  toolCalls: number;
  metrics: {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cachedTokens: number;
  };
  signal?: AbortSignal;
  abortListener?: () => void;
  settled: boolean;
  cancelRequested: boolean;
  nextToolId: number;
  toolIds: Map<string, string>;
  sawEvent: boolean;
  sawThought: boolean;
  sawText: boolean;
}

function errorMessage(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export class AgyWorker {
  public readonly model?: string;
  public readonly mode?: string;

  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private stopPromise?: Promise<void>;
  private active?: ActiveTurn;
  private ready = false;
  private disposed = false;
  private expectedExit = false;
  private sawExit = false;
  private fatalError?: Error;
  private terminalError?: Error;
  private outputChain: Promise<void> = Promise.resolve();
  private stdoutBuffer = "";
  private retainedStderr = "";
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private readonly trace: TimingTrace;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private _conversationId?: string;
  private _used = false;

  public constructor(private readonly options: AgyWorkerOptions) {
    this.model = options.model;
    this.mode = options.mode;
    this._conversationId = options.conversationId;
    this.trace = new TimingTrace("agy", options.conversationId ?? "pending", options.env ?? process.env);
  }

  public get conversationId(): string | undefined {
    return this._conversationId;
  }

  public get used(): boolean {
    return this._used;
  }

  public get hasActiveTurn(): boolean {
    return this.active !== undefined;
  }

  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AGY worker is disposed"));
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (this.ready) return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.startPromise) return this.startPromise;

    const args = [
      "-p", "",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout", "24h",
    ];
    if (this.options.conversationId) args.push("--conversation", this.options.conversationId);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.mode) args.push("--mode", this.options.mode);
    if (this.options.cwd) args.push("--add-dir", this.options.cwd);

    this.trace.mark("worker_start");
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });

    try {
      this.child = spawnCommand(this.options.command, args, {
        cwd: this.options.cwd,
        env: this.options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.attachProcess(this.child);
    } catch (error) {
      this.fail(new Error(`Failed to spawn AGY: ${errorMessage(error instanceof Error ? error.message : error, "unknown error")}`));
      return this.startPromise;
    }

    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    this.startupTimer = setTimeout(() => {
      const diagnostics = this.retainedStderr ? `: ${this.retainedStderr}` : "";
      this.fail(new Error(`AGY startup timed out after ${timeoutMs}ms${diagnostics}`));
    }, timeoutMs);

    return this.startPromise;
  }

  public async runTurn(
    prompt: string,
    callbacks: AgyTurnCallbacks,
    signal?: AbortSignal,
  ): Promise<TurnResult> {
    if (this.disposed) throw new Error("AGY worker is disposed");
    if (this.fatalError) throw this.fatalError;
    if (!this.ready || !this.child) throw new Error("AGY worker has not started");
    if (this.active) throw new Error("An AGY turn is already active");
    if (signal?.aborted) {
      return { exitCode: null, stdout: "", stderr: "", cancelled: true };
    }

    const turnPromise = new Promise<TurnResult>((resolve, reject) => {
      this.active = {
        callbacks,
        resolve,
        reject,
        stdout: "",
        stderr: "",
        streamedText: false,
        toolCalls: 0,
        metrics: { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0 },
        signal,
        settled: false,
        cancelRequested: false,
        nextToolId: 0,
        toolIds: new Map(),
        sawEvent: false,
        sawThought: false,
        sawText: false,
      };
    });

    if (signal) {
      const listener = () => void this.cancel().catch(() => undefined);
      this.active!.abortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
    }

    const input = {
      event: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    };

    const stdin = this.child.stdin;
    if (!stdin.writable || stdin.writableEnded || stdin.destroyed) {
      this.fail(new Error("Failed to write AGY prompt: stdin is closed"));
      return turnPromise;
    }
    try {
      stdin.write(`${JSON.stringify(input)}\n`, (error) => {
        if (error) this.fail(new Error(`Failed to write AGY prompt: ${error.message}`));
      });
      this._used = true;
      this.trace.mark("prompt_written");
      callbacks.trace?.mark("backend_accepted");
    } catch (error) {
      this.fail(new Error(`Failed to write AGY prompt: ${errorMessage(error instanceof Error ? error.message : error, "unknown error")}`));
    }

    return turnPromise;
  }

  public async cancel(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    turn.cancelRequested = true;
    this.terminalError = new Error("AGY worker was cancelled and is terminal");
    this.expectedExit = true;
    this.finishCancelled(turn);
    try {
      await this.stopChild();
    } catch (error) {
      throw this.asError(error, "Failed to stop cancelled AGY worker");
    }
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.ready = false;
    const disposalError = new Error("AGY worker was disposed during startup");
    this.rejectStart?.(disposalError);
    this.clearStartSettlement();
    this.disposePromise = (async () => {
      const turn = this.active;
      if (turn) {
        turn.cancelRequested = true;
        this.finishCancelled(turn);
      }
      this.expectedExit = true;
      await this.stopChild();
    })();
    return this.disposePromise;
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    child.stdout.on("data", (chunk: Buffer) => {
      const decoded = this.stdoutDecoder.write(chunk);
      if (!decoded) return;
      this.stdoutBuffer += decoded;
      const lines = this.stdoutBuffer.split("\n");
      this.stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) this.enqueueLine(line);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const decoded = this.stderrDecoder.write(chunk);
      if (!decoded) return;
      this.retainStderr(decoded);
      const turn = this.active;
      if (turn) {
        turn.stderr += decoded;
        if (turn.callbacks.onStderr) {
          this.outputChain = this.outputChain
            .then(() => turn.callbacks.onStderr!(decoded))
            .catch((error) => this.fail(this.asError(error, "AGY stderr callback failed")));
        }
      }
    });

    child.stdin.on("error", (error) => {
      if (!this.disposed && !this.fatalError) this.fail(new Error(`AGY stdin failed: ${error.message}`));
    });
    child.stdin.once("close", () => {
      if (!this.disposed && !this.expectedExit && !this.sawExit && !this.fatalError) {
        this.fail(new Error("AGY stdin closed unexpectedly"));
      }
    });
    child.once("error", (error) => this.fail(new Error(`Failed to spawn AGY: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.sawExit = true;
      this.ready = false;
      if (this.disposed || this.expectedExit || this.fatalError) return;

      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.handleExit(code, signal);
      };
      const timer = setTimeout(finish, 25);
      child.once("close", finish);
    });
    child.once("close", (code, signal) => {
      const stdoutTail = this.stdoutDecoder.end();
      if (stdoutTail) this.stdoutBuffer += stdoutTail;
      if (this.stdoutBuffer.trim()) this.enqueueLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
      const stderrTail = this.stderrDecoder.end();
      if (stderrTail) this.retainStderr(stderrTail);
      if (!this.sawExit) void this.outputChain.then(() => this.handleExit(code, signal));
    });
  }

  private enqueueLine(line: string): void {
    this.outputChain = this.outputChain
      .then(() => this.handleLine(line))
      .catch((error) => this.fail(this.asError(error, "AGY output handling failed")));
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    let data: any;
    try {
      data = JSON.parse(trimmed);
    } catch {
      throw new Error(`Malformed AGY NDJSON: ${trimmed}`);
    }
    if (!data || typeof data !== "object") throw new Error(`Malformed AGY NDJSON: ${trimmed}`);

    if (data.event === "init") {
      if (!this.ready) {
        if (this.disposed || this.terminalError || this.fatalError) return;
        this.ready = true;
        this._conversationId = data.conversation_id ?? data.init?.conversation_id ?? this._conversationId;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.startupTimer = undefined;
        this.resolveStart?.();
        this.clearStartSettlement();
        this.trace.mark("worker_ready");
      }
      return;
    }

    const turn = this.active;
    if (!turn || turn.settled || turn.cancelRequested) return;
    turn.stdout += `${line}\n`;
    if (!turn.sawEvent) {
      turn.sawEvent = true;
      turn.callbacks.trace?.mark("first_event");
    }

    if (data.event === "step_update" && data.step_update) {
      const update = data.step_update;
      this.updateMetrics(turn, update.usage);
      if (update.step_type === "agent_response" && update.text_delta) {
        const text = sanitizeText(update.text_delta);
        if (text) {
          if (!turn.sawText) {
            turn.sawText = true;
            turn.callbacks.trace?.mark("first_text");
          }
          turn.streamedText = true;
          await turn.callbacks.onChunk?.(text);
        }
      } else if (update.step_type === "thought" && update.text_delta) {
        const text = sanitizeText(update.text_delta);
        if (text) {
          if (!turn.sawThought) {
            turn.sawThought = true;
            turn.callbacks.trace?.mark("first_thought");
          }
          await turn.callbacks.onThought?.(text);
        }
      } else if (update.step_type === "tool" && update.tool_info) {
        const key = String(update.step_index ?? update.tool_info.tool_name ?? "tool");
        if (update.state === "ACTIVE") {
          const id = `call_${update.step_index ?? ++turn.nextToolId}`;
          turn.toolIds.set(key, id);
          turn.toolCalls++;
          if (turn.callbacks.onToolStart) {
            await turn.callbacks.onToolStart(
              id,
              update.tool_info.tool_name ?? "Tool",
              update.tool_info.parameters ?? {},
            );
          }
        } else if (update.state === "DONE" || update.state === "ERROR") {
          const id = turn.toolIds.get(key) ?? `call_${update.step_index ?? ++turn.nextToolId}`;
          turn.toolIds.delete(key);
          if (turn.callbacks.onToolEnd) {
            const output = update.state === "ERROR"
              ? update.tool_info.error ?? update.tool_info.output ?? "Tool failed"
              : update.tool_info.output ?? "ok";
            await turn.callbacks.onToolEnd(id, this.stringifyToolOutput(output));
          }
        }
      }
      return;
    }

    if (data.event !== "result" || !data.result) return;
    this.updateMetrics(turn, data.result.usage);
    this._conversationId = data.result.conversation_id ?? this._conversationId;

    if (turn.callbacks.onMetrics) {
      await turn.callbacks.onMetrics({ ...turn.metrics, toolCalls: turn.toolCalls });
    }
    if (turn.settled || turn.cancelRequested) return;

    if (data.result.status === "ERROR") {
      this.rejectTurn(turn, new Error(errorMessage(data.result.error, "AGY returned an error")));
      return;
    }

    if (!turn.streamedText && data.result.response) {
      const text = sanitizeText(data.result.response);
      if (text) {
        if (!turn.sawText) {
          turn.sawText = true;
          turn.callbacks.trace?.mark("first_text");
        }
        turn.streamedText = true;
        await turn.callbacks.onChunk?.(text);
      }
    }
    if (turn.settled || turn.cancelRequested) return;
    this.resolveTurn(turn, {
      exitCode: null,
      stdout: turn.stdout,
      stderr: turn.stderr,
      cancelled: false,
    });
    this.trace.mark("turn_result");
  }

  private updateMetrics(turn: ActiveTurn, usage: any): void {
    if (!usage) return;
    turn.metrics.inputTokens = usage.input_tokens ?? turn.metrics.inputTokens;
    turn.metrics.outputTokens = usage.output_tokens ?? turn.metrics.outputTokens;
    turn.metrics.thinkingTokens = usage.thinking_tokens ?? turn.metrics.thinkingTokens;
    turn.metrics.cachedTokens = usage.cache_read_tokens ?? turn.metrics.cachedTokens;
  }

  private stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.ready = false;
    if (this.disposed || this.expectedExit) return;
    if (this.fatalError) return;
    const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
    const diagnostics = this.retainedStderr ? `: ${this.retainedStderr}` : "";
    this.fail(new Error(`AGY process exited unexpectedly with ${reason}${diagnostics}`));
  }

  private fail(error: Error): void {
    if (this.fatalError || this.disposed) return;
    this.fatalError = error;
    this.terminalError = error;
    this.ready = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.rejectStart?.(error);
    this.clearStartSettlement();
    if (this.active) this.rejectTurn(this.active, error);
    void this.stopChild().catch((stopError) => {
      this.retainStderr(`\nFailed to stop AGY worker: ${this.asError(stopError, "unknown error").message}`);
    });
  }

  private resolveTurn(turn: ActiveTurn, result: TurnResult): void {
    if (turn.settled) return;
    turn.settled = true;
    this.cleanupTurn(turn);
    turn.resolve(result);
  }

  private rejectTurn(turn: ActiveTurn, error: Error): void {
    if (turn.settled) return;
    turn.settled = true;
    this.cleanupTurn(turn);
    turn.reject(error);
  }

  private finishCancelled(turn: ActiveTurn): void {
    this.resolveTurn(turn, {
      exitCode: this.child?.exitCode ?? null,
      stdout: turn.stdout,
      stderr: turn.stderr,
      cancelled: true,
    });
  }

  private cleanupTurn(turn: ActiveTurn): void {
    turn.callbacks.trace?.mark("turn_completed");
    if (turn.signal && turn.abortListener) turn.signal.removeEventListener("abort", turn.abortListener);
    if (this.active === turn) this.active = undefined;
  }

  private retainStderr(value: string): void {
    this.retainedStderr = (this.retainedStderr + value).slice(-2_048);
  }

  private clearStartSettlement(): void {
    this.resolveStart = undefined;
    this.rejectStart = undefined;
  }

  private async stopChild(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const child = this.child;
    if (!child) return;
    this.stopPromise = terminateProcess(child);
    return this.stopPromise;
  }

  private asError(value: unknown, fallback: string): Error {
    return value instanceof Error ? value : new Error(errorMessage(value, fallback));
  }
}
