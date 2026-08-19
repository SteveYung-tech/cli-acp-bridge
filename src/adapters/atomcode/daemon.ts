import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnCommand, terminateProcess, type ProcessCommand } from "../../runtime/process-command.js";
import { TimingTrace } from "../../runtime/timing.js";
import { SseParser } from "./sse.js";

export interface AtomCodeDaemonOptions {
  command: ProcessCommand;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  registryDirectory?: string;
}

export interface AtomCodeSession {
  id: string;
  name: string;
  working_dir: string;
  project_hash: string;
  created_at: number;
}

export interface AtomCodeChatRequest {
  message: string;
  working_dir: string;
  session_id: string;
  request_id: string;
  provider?: string;
  approval_mode?: string;
}

export interface AtomCodeChatEvent {
  type: string;
  [key: string]: unknown;
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Unable to reserve an AtomCode daemon port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

export class AtomCodeDaemon {
  private child?: ChildProcessWithoutNullStreams;
  private startPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private baseUrl?: string;
  private daemonPort?: number;
  private authToken?: string;
  private retainedStderr = "";
  private fatalError?: Error;
  private ready = false;
  private disposed = false;
  private readonly lifetimeController = new AbortController();
  private readonly trace: TimingTrace;

  public constructor(private readonly options: AtomCodeDaemonOptions) {
    this.trace = new TimingTrace("atomcode", "daemon", options.env ?? process.env);
  }

  public start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("AtomCode daemon is disposed"));
    if (this.ready) return Promise.resolve();
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.startPromise) {
      this.startPromise = this.startInternal();
      void this.startPromise.catch(() => undefined);
    }
    return this.startPromise;
  }

  public async createSession(cwd: string): Promise<AtomCodeSession> {
    return this.postJson<AtomCodeSession>("/sessions", { working_dir: cwd }, [200, 201]);
  }

  public async chat(
    request: AtomCodeChatRequest,
    onEvent: (event: AtomCodeChatEvent) => void | Promise<void>,
    signal?: AbortSignal,
    onAccepted?: () => void | Promise<void>,
  ): Promise<void> {
    await this.ensureReady();
    const response = await this.fetchAuthenticated("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await this.responseError("AtomCode chat", response);
    if (!response.body) throw new Error("AtomCode chat response has no body");
    await onAccepted?.();

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    while (true) {
      const { done, value } = await reader.read();
      const payloads = done
        ? [...parser.push(decoder.decode()), ...parser.finish()]
        : parser.push(decoder.decode(value, { stream: true }));
      for (const payload of payloads) {
        let event: AtomCodeChatEvent;
        try {
          event = JSON.parse(payload) as AtomCodeChatEvent;
        } catch {
          throw new Error(`Malformed AtomCode SSE payload: ${payload}`);
        }
        if (!event || typeof event.type !== "string") {
          throw new Error(`Malformed AtomCode chat event: ${payload}`);
        }
        await onEvent(event);
      }
      if (done) break;
    }
  }

  public async stop(sessionOrRequestId: string): Promise<void> {
    await this.postJson("/chat/stop", { session_id: sessionOrRequestId });
  }

  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.lifetimeController.abort();
    this.disposePromise = (async () => {
      if (this.startPromise) await this.startPromise.catch(() => undefined);
      if (this.baseUrl && this.child?.exitCode === null && this.child.signalCode === null) {
        try {
          await this.fetchAuthenticated("/shutdown", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(500),
          });
        } catch {
          // Process termination below is the bounded fallback.
        }
      }
      if (this.child) await terminateProcess(this.child, 250);
      this.ready = false;
    })();
    return this.disposePromise;
  }

  private async startInternal(): Promise<void> {
    const port = await reserveLoopbackPort();
    if (this.disposed) throw new Error("AtomCode daemon was disposed during startup");
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.daemonPort = port;
    const args = [
      "--dev",
      "daemon",
      "--port", String(port),
      "--client", "atomcode-acp",
      "--idle-timeout", "0",
      "--no-telemetry",
    ];
    this.trace.mark("daemon_start");

    try {
      this.child = spawnCommand(this.options.command, args, {
        cwd: process.cwd(),
        env: this.options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      throw this.recordFatal(this.asError(error, "Failed to spawn AtomCode daemon"));
    }
    this.attachProcess(this.child);

    const timeoutMs = this.options.startupTimeoutMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error("AtomCode daemon was disposed during startup");
      if (this.fatalError) throw this.fatalError;
      try {
        const response = await fetch(`${this.baseUrl}/health`, {
          signal: AbortSignal.any([AbortSignal.timeout(200), this.lifetimeController.signal]),
        });
        if (response.ok) {
          await this.refreshAuthToken();
          this.ready = true;
          this.trace.mark("daemon_ready");
          return;
        }
      } catch {
        if (this.disposed) throw new Error("AtomCode daemon was disposed during startup");
        if (this.fatalError) throw this.fatalError;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const diagnostics = this.retainedStderr ? `: ${this.retainedStderr}` : "";
    const error = this.recordFatal(new Error(`AtomCode daemon startup timed out after ${timeoutMs}ms${diagnostics}`));
    if (this.child) await terminateProcess(this.child).catch(() => undefined);
    throw error;
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    child.stdout.resume();
    child.stderr.on("data", (chunk: Buffer) => {
      this.retainedStderr = (this.retainedStderr + chunk.toString("utf8")).slice(-2_048);
    });
    child.once("error", (error) => this.recordFatal(new Error(`AtomCode daemon failed: ${error.message}`)));
    child.once("exit", (code, signal) => {
      this.ready = false;
      if (this.disposed) return;
      const reason = code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`;
      const diagnostics = this.retainedStderr ? `: ${this.retainedStderr}` : "";
      this.recordFatal(new Error(`AtomCode daemon exited unexpectedly with ${reason}${diagnostics}`));
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error("AtomCode daemon is disposed");
    await this.start();
    if (this.fatalError) throw this.fatalError;
    if (!this.ready || !this.baseUrl) throw new Error("AtomCode daemon is not ready");
  }

  private async postJson<T = unknown>(path: string, body: unknown, accepted = [200]): Promise<T> {
    await this.ensureReady();
    const response = await this.fetchAuthenticated(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!accepted.includes(response.status)) throw await this.responseError(`AtomCode ${path}`, response);
    return await response.json() as T;
  }

  private async responseError(label: string, response: Response): Promise<Error> {
    const detail = (await response.text()).slice(0, 2_048);
    return new Error(`${label} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  private async fetchAuthenticated(path: string, init: RequestInit): Promise<Response> {
    if (!this.baseUrl) throw new Error("AtomCode daemon URL is unavailable");
    let response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authenticatedHeaders(init.headers),
    });
    if (response.status !== 401) return response;

    await this.refreshAuthToken();
    if (!this.authToken) return response;
    await response.body?.cancel().catch(() => undefined);
    response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: this.authenticatedHeaders(init.headers),
    });
    return response;
  }

  private authenticatedHeaders(source?: HeadersInit): Headers {
    const headers = new Headers(source);
    if (this.authToken) headers.set("Authorization", `Bearer ${this.authToken}`);
    return headers;
  }

  private async refreshAuthToken(): Promise<void> {
    if (!this.daemonPort) return;
    const env = this.options.env ?? process.env;
    const directory = this.options.registryDirectory
      ?? env.ATOMCODE_HOME
      ?? join(env.USERPROFILE ?? env.HOME ?? homedir(), ".atomcode");
    try {
      const registry = JSON.parse(
        await readFile(join(directory, `daemon-${this.daemonPort}.json`), "utf8"),
      ) as { port?: unknown; token?: unknown };
      if (
        (registry.port === undefined || registry.port === this.daemonPort) &&
        typeof registry.token === "string" &&
        registry.token.length > 0
      ) {
        this.authToken = registry.token;
      }
    } catch {
      // Older daemons and deterministic test fixtures may not require authentication.
    }
  }

  private recordFatal(error: Error): Error {
    this.fatalError ??= error;
    this.ready = false;
    return this.fatalError;
  }

  private asError(value: unknown, fallback: string): Error {
    if (value instanceof Error) return new Error(`${fallback}: ${value.message}`);
    return new Error(`${fallback}: ${String(value)}`);
  }
}
