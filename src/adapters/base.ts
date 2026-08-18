import * as acp from "@agentclientprotocol/sdk";
import type { SessionState } from "../session/manager.js";

export interface ExecuteTurnOptions {
  cwd?: string;
  prompt: string;
  continueSession?: boolean;
  model?: string;
  mode?: string;
  provider?: string;
  signal?: AbortSignal;
  onThought?: (thought: string) => void | Promise<void>;
  onChunk?: (chunk: string) => void | Promise<void>;
  onToolStart?: (toolCallId: string, toolName: string, input: any) => void | Promise<void>;
  onToolEnd?: (toolCallId: string, result: string) => void | Promise<void>;
  onMetrics?: (metrics: {
    inputTokens?: number;
    outputTokens?: number;
    thinkingTokens?: number;
    cachedTokens?: number;
    toolCalls?: number;
  }) => void | Promise<void>;
  onStderr?: (log: string) => void | Promise<void>;
}

export interface TurnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
}

export interface AgentAdapter {
  readonly id: string;
  readonly name: string;
  readonly defaultBinaryName: string;
  readonly binaryEnvVar: string;
  resolveBinaryPath(): string;
  getAvailableConfigOptions(session: SessionState): acp.SessionConfigOption[];
  getAvailableCommands(session: SessionState): acp.AvailableCommand[];
  executeTurn(options: ExecuteTurnOptions): Promise<TurnResult>;
}
