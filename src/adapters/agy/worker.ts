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
  "onThought" | "onChunk" | "onToolStart" | "onToolEnd" | "onMetrics" | "onStderr"
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
  private active?: ActiveTurn;
  private ready = false;
  private disposed = false;
  private expectedExit = false;
  private fatalError?: Error;
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

  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AGY worker is disposed"));
    if (this.ready) return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.startPromise) return this.startPromise;

    const args = [
      "-p", "",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
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
      void this.stopChild();
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
      };
    });

    if (signal) {
      const listener = () => void this.cancel().catch(() => undefined);
      this.active!.abortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
    }

    const input = {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
    };

    try {
      this.child.stdin.write(`${JSON.stringify(input)}\n`);
      this._used = true;
      this.trace.mark("prompt_written");
    } catch (error) {
      this.fail(new Error(`Failed to write AGY prompt: ${errorMessage(error instanceof Error ? error.message : error, "unknown error")}`));
    }

    return turnPromise;
  }

  public async cancel(): Promise<void> {
    const turn = this.active;
    if (!turn) return;
    this.expectedExit = true;
    try {
      await this.stopChild();
    } finally {
      if (this.active === turn) this.finishCancelled(turn);
    }
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = (async () => {
      const turn = this.active;
      this.expectedExit = true;
      try {
        await this.stopChild();
      } finally {
        if (turn && this.active === turn) this.finishCancelled(turn);
        if (this.rejectStart) {
          this.rejectStart(new Error("AGY worker was disposed during startup"));
          this.clearStartSettlement();
        }
      }
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
    child.once("error", (error) => this.fail(new Error(`Failed to spawn AGY: ${error.message}`)));
    child.once("close", (code, signal) => {
      const stdoutTail = this.stdoutDecoder.end();
      if (stdoutTail) this.stdoutBuffer += stdoutTail;
      if (this.stdoutBuffer.trim()) this.enqueueLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
      const stderrTail = this.stderrDecoder.end();
      if (stderrTail) this.retainStderr(stderrTail);
      void this.outputChain.then(() => this.handleExit(code, signal));
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
    if (!turn) return;
    turn.stdout += `${line}\n`;

    if (data.event === "step_update" && data.step_update) {
      const update = data.step_update;
      this.updateMetrics(turn, update.usage);
      if (update.step_type === "agent_response" && update.text_delta && turn.callbacks.onChunk) {
        const text = sanitizeText(update.text_delta);
        if (text) {
          turn.streamedText = true;
          await turn.callbacks.onChunk(text);
        }
      } else if (update.step_type === "thought" && update.text_delta && turn.callbacks.onThought) {
        const text = sanitizeText(update.text_delta);
        if (text) await turn.callbacks.onThought(text);
      } else if (update.step_type === "tool_call" && turn.callbacks.onToolStart) {
        turn.toolCalls++;
        await turn.callbacks.onToolStart(
          `call_${update.step_index ?? Date.now()}`,
          update.tool_name ?? "Tool",
          update.input ?? {},
        );
      } else if (update.step_type === "tool_result" && turn.callbacks.onToolEnd) {
        await turn.callbacks.onToolEnd(
          `call_${update.step_index ?? Date.now()}`,
          update.output ?? "ok",
        );
      }
      return;
    }

    if (data.event !== "result" || !data.result) return;
    this.updateMetrics(turn, data.result.usage);
    this._conversationId = data.result.conversation_id ?? this._conversationId;

    if (data.result.status === "ERROR") {
      this.rejectTurn(turn, new Error(errorMessage(data.result.error, "AGY returned an error")));
      return;
    }

    if (!turn.streamedText && data.result.response && turn.callbacks.onChunk) {
      const text = sanitizeText(data.result.response);
      if (text) {
        turn.streamedText = true;
        await turn.callbacks.onChunk(text);
      }
    }
    if (turn.callbacks.onMetrics) {
      await turn.callbacks.onMetrics({ ...turn.metrics, toolCalls: turn.toolCalls });
    }
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
    this.ready = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = undefined;
    this.rejectStart?.(error);
    this.clearStartSettlement();
    if (this.active) this.rejectTurn(this.active, error);
    void this.stopChild();
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
    const child = this.child;
    if (!child) return;
    await terminateProcess(child);
  }

  private asError(value: unknown, fallback: string): Error {
    return value instanceof Error ? value : new Error(errorMessage(value, fallback));
  }
}
