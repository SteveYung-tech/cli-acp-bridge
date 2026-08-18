import crypto from "node:crypto";

export interface SessionMetrics {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalThinkingTokens: number;
  totalCachedTokens: number;
  totalToolCalls: number;
  lastPromptTokens: number;
}

export interface SessionState {
  id: string;
  cwd: string;
  turnCount: number;
  model?: string;
  mode?: string;
  provider?: string;
  metrics: SessionMetrics;
  configOptions: Record<string, string>;
  activeAbortController: AbortController | null;
  currentTurnPromise: Promise<any> | null;
  createdAt: number;
  updatedAt: number;
}

export class SessionManager {
  private sessions: Map<string, SessionState> = new Map();

  /**
   * Create a new ACP session with an optional working directory.
   */
  public createSession(cwd?: string): SessionState {
    const sessionId = crypto.randomUUID();
    const resolvedCwd = cwd || process.cwd();

    const session: SessionState = {
      id: sessionId,
      cwd: resolvedCwd,
      turnCount: 0,
      metrics: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalThinkingTokens: 0,
        totalCachedTokens: 0,
        totalToolCalls: 0,
        lastPromptTokens: 0,
      },
      configOptions: {},
      activeAbortController: null,
      currentTurnPromise: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Get an existing session by ID.
   */
  public getSession(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Snapshot all sessions so the server can release their backend resources.
   */
  public getSessions(): SessionState[] {
    return [...this.sessions.values()];
  }

  /**
   * Update session option.
   */
  public setSessionOption(sessionId: string, key: string, value: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (key === "model") {
      session.model = value;
    } else if (key === "mode") {
      session.mode = value;
    } else if (key === "provider") {
      session.provider = value;
    } else {
      session.configOptions[key] = value;
    }

    session.updatedAt = Date.now();
    return true;
  }

  /**
   * Record token usage and metrics into the session.
   */
  public addMetrics(
    sessionId: string,
    delta: {
      inputTokens?: number;
      outputTokens?: number;
      thinkingTokens?: number;
      cachedTokens?: number;
      toolCalls?: number;
    }
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (delta.inputTokens) {
      session.metrics.totalInputTokens += delta.inputTokens;
      session.metrics.lastPromptTokens = delta.inputTokens;
    }
    if (delta.outputTokens) session.metrics.totalOutputTokens += delta.outputTokens;
    if (delta.thinkingTokens) session.metrics.totalThinkingTokens += delta.thinkingTokens;
    if (delta.cachedTokens) session.metrics.totalCachedTokens += delta.cachedTokens;
    if (delta.toolCalls) session.metrics.totalToolCalls += delta.toolCalls;
  }

  /**
   * Remove a session.
   */
  public deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session?.activeAbortController) {
      session.activeAbortController.abort();
    }
    return this.sessions.delete(sessionId);
  }

  /**
   * Cancel an active turn in a session without resetting the session state.
   */
  public cancelSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session?.activeAbortController) {
      session.activeAbortController.abort();
      return true;
    }
    return false;
  }
}
