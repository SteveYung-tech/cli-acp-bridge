import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter } from "../adapters/base.js";
import { SessionManager } from "../session/manager.js";
import { expandSlashCommand } from "../commands/prompt-templates.js";
import { handleLocalSlashCommand } from "../commands/local-handlers.js";
import { sanitizeText } from "../stream/parser.js";
import { TimingTrace } from "../runtime/timing.js";

/**
 * Extracts plain text from an ACP prompt parameter.
 */
function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  if (Array.isArray(prompt)) {
    const parts: string[] = [];
    for (const block of prompt) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block && typeof block === "object") {
        if ("type" in block && block.type === "text" && "text" in block && typeof block.text === "string") {
          parts.push(block.text);
        } else if ("text" in block && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return parts.join("\n");
  }
  if (prompt && typeof prompt === "object" && "text" in prompt && typeof prompt.text === "string") {
    return prompt.text;
  }
  return String(prompt || "");
}

function toolInputKeys(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  return Object.keys(input).map((key) => key.toLowerCase());
}

function toolPresentation(toolName: string, input: unknown): { title: string; kind: acp.ToolKind } {
  const normalizedName = toolName.trim().toLowerCase();
  const keys = toolInputKeys(input);
  const hasKey = (...names: string[]) => names.some((name) => keys.includes(name.toLowerCase()));

  if (hasKey("TargetFile", "Patch", "Edits") || /edit|write|create|patch|replace/.test(normalizedName)) {
    return { title: normalizedName === "tool" ? "Edit" : toolName, kind: "edit" };
  }
  if (/delete|remove/.test(normalizedName)) return { title: toolName, kind: "delete" };
  if (/move|rename/.test(normalizedName)) return { title: toolName, kind: "move" };
  if (hasKey("Query", "SearchPath", "Pattern") || /search|find|grep/.test(normalizedName)) {
    return { title: normalizedName === "tool" ? "Search" : toolName, kind: "search" };
  }
  if (hasKey("AbsolutePath", "FilePath") || /read|view|list|glob/.test(normalizedName)) {
    return { title: normalizedName === "tool" ? "Read" : toolName, kind: "read" };
  }
  if (/fetch|web|url/.test(normalizedName)) return { title: toolName, kind: "fetch" };
  if (/think|reason/.test(normalizedName)) return { title: toolName, kind: "think" };
  if (hasKey("CommandLine", "Command") || /bash|shell|terminal|execute|command/.test(normalizedName)) {
    return { title: normalizedName === "tool" ? "Shell" : toolName, kind: "execute" };
  }
  if (hasKey("Action", "TaskId") || /task|agent/.test(normalizedName)) {
    return { title: normalizedName === "tool" ? "Task" : toolName, kind: "other" };
  }
  return { title: normalizedName === "tool" ? "Tool" : toolName, kind: "other" };
}

export function createAgentServer(adapter: AgentAdapter) {
  const sessionManager = new SessionManager();
  const closingSessions = new Map<string, Promise<void>>();
  let disposePromise: Promise<void> | undefined;
  const ready = adapter.start();
  void ready.catch(() => undefined);

  const agentApp = acp.agent({
    name: adapter.id + "-acp",
  });

  // 1. Initialize Handshake
  agentApp.onRequest(acp.methods.agent.initialize, async (_ctx) => {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          close: {},
          delete: {},
        },
      },
    };
  });

  // 2. Authenticate
  agentApp.onRequest(acp.methods.agent.authenticate, async (_ctx) => {
    return {};
  });

  // 3. session/new
  agentApp.onRequest(acp.methods.agent.session.new, async (ctx) => {
    const params = ctx.params as { cwd?: string; [key: string]: unknown } | undefined;
    const session = sessionManager.createSession(params?.cwd);
    const configOptions = adapter.getAvailableConfigOptions(session);
    for (const option of configOptions) {
      if (
        (option.id === "model" || option.id === "mode" || option.id === "provider") &&
        typeof option.currentValue === "string"
      ) {
        sessionManager.setSessionOption(session.id, option.id, option.currentValue);
      }
    }
    adapter.createSession(session);

    // Notify CodeG of available slash commands for autocomplete
    const commands = adapter.getAvailableCommands(session);
    if (commands && commands.length > 0) {
      setTimeout(async () => {
        try {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: commands,
            },
          });
        } catch (err) {
          console.error("Failed to notify available commands:", err);
        }
      }, 50);
    }

    return {
      sessionId: session.id,
      configOptions,
    };
  });

  // 4. session/set_mode
  agentApp.onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const params = ctx.params as { sessionId: string; modeId?: string };
    if (params?.sessionId && params.modeId) {
      sessionManager.setSessionOption(params.sessionId, "mode", params.modeId);
      const session = sessionManager.getSession(params.sessionId);
      if (session) await adapter.updateSession(session);
    }
    return {};
  });

  // 5. session/set_config_option
  agentApp.onRequest(acp.methods.agent.session.setConfigOption, async (ctx) => {
    const params = ctx.params;
    if (params?.sessionId && params.configId && params.value !== undefined) {
      sessionManager.setSessionOption(params.sessionId, params.configId, String(params.value));
    }
    const session = sessionManager.getSession(params.sessionId);
    if (session) await adapter.updateSession(session);
    return {
      configOptions: session ? adapter.getAvailableConfigOptions(session) : [],
    };
  });

  // 6. session/prompt (Multi-turn turn execution with clean interruption and queueing)
  agentApp.onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const params = ctx.params as {
      sessionId: string;
      prompt: unknown;
      [key: string]: unknown;
    };

    const session = sessionManager.getSession(params.sessionId);
    if (!session) {
      throw new Error(`Session ${params.sessionId} not found`);
    }

    const promptText = extractPromptText(params.prompt);
    if (!promptText.trim()) {
      return {
        stopReason: "end_turn" as const,
      };
    }

    // Direct instant local slash command execution (/usage, /cost, /status, /help, /skills, /mcp)
    // Runs locally in 1ms with ZERO LLM invocation & ZERO token waste!
    const localResult = handleLocalSlashCommand(promptText, session, adapter);
    if (localResult.handled && localResult.content) {
      await ctx.client.notify(acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: localResult.content,
          },
        },
      });
      return {
        stopReason: "end_turn" as const,
      };
    }

    // 1. If previous turn is in-flight, abort it and wait for process cleanup
    if (session.activeAbortController) {
      await adapter.cancelTurn(session.id);
      session.activeAbortController.abort();
      if (session.currentTurnPromise) {
        try {
          await session.currentTurnPromise;
        } catch {
          // Ignore previous turn cancellation errors
        }
      }
    }

    const abortController = new AbortController();
    session.activeAbortController = abortController;

    const continueSession = session.turnCount > 0;
    const trace = new TimingTrace(adapter.id, session.id);
    trace.mark("prompt_received");

    const turnPromise = (async () => {
      try {
        await ready;
        const result = await adapter.executeTurn({
          sessionId: session.id,
          cwd: session.cwd,
          prompt: expandSlashCommand(promptText),
          continueSession,
          model: session.model,
          mode: session.mode,
          provider: session.provider,
          trace,
          signal: abortController.signal,
          onMetrics: async (delta) => {
            sessionManager.addMetrics(session.id, delta);
          },
          onThought: async (thought) => {
            const cleanThought = sanitizeText(thought);
            if (!cleanThought) return;
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: {
                    type: "text",
                    text: cleanThought,
                  },
                },
              });
            } catch (err) {
              console.error("Failed to send thought chunk:", err);
            }
          },
          onChunk: async (chunk) => {
            const cleanChunk = sanitizeText(chunk);
            if (!cleanChunk) return;
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: cleanChunk,
                  },
                },
              });
            } catch (err) {
              console.error("Failed to send message chunk:", err);
            }
          },
          onToolStart: async (toolCallId, toolName, toolInput) => {
            try {
              const presentation = toolPresentation(toolName, toolInput);
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: presentation.title,
                  kind: presentation.kind,
                  status: "in_progress",
                  rawInput: toolInput,
                },
              });
            } catch (err) {
              console.error("Failed to send tool call:", err);
            }
          },
          onToolEnd: async (toolCallId, toolResult) => {
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId,
                  status: "completed",
                  rawOutput: { result: toolResult },
                },
              });
            } catch (err) {
              console.error("Failed to send tool end update:", err);
            }
          },
        });

        session.turnCount++;
        session.updatedAt = Date.now();

        if (result.cancelled || abortController.signal.aborted) {
          return {
            stopReason: "cancelled" as const,
          };
        }

        return {
          stopReason: "end_turn" as const,
        };
      } catch (err: unknown) {
        if (abortController.signal.aborted) {
          session.turnCount++;
          return {
            stopReason: "cancelled" as const,
          };
        }
        const detail = sanitizeText(err instanceof Error ? err.message : String(err)).trim();
        const message = `${adapter.name} failed: ${detail || "unknown backend error"}`;
        try {
          await ctx.client.notify(acp.methods.client.session.update, {
            sessionId: session.id,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: message,
              },
            },
          });
        } catch (notifyError) {
          console.error("Failed to send backend error message:", notifyError);
        }
        session.turnCount++;
        session.updatedAt = Date.now();
        return {
          stopReason: "end_turn" as const,
        };
      } finally {
        if (session.activeAbortController === abortController) {
          session.activeAbortController = null;
        }
        session.currentTurnPromise = null;
      }
    })();

    session.currentTurnPromise = turnPromise;
    return await turnPromise;
  });

  // 7. session/cancel (Non-destructive clean interruption)
  agentApp.onNotification(acp.methods.agent.session.cancel, async (ctx) => {
    const params = ctx.params as { sessionId: string };
    if (params?.sessionId) {
      await adapter.cancelTurn(params.sessionId);
      sessionManager.cancelSession(params.sessionId);
    }
  });

  const closeManagedSession = (sessionId: string): Promise<void> => {
    const inProgress = closingSessions.get(sessionId);
    if (inProgress) return inProgress;
    const session = sessionManager.getSession(sessionId);
    if (!session) return Promise.resolve();

    const closing = (async () => {
      let cancellationError: unknown;
      try {
        await adapter.cancelTurn(sessionId);
      } catch (error) {
        cancellationError = error;
      }
      sessionManager.cancelSession(sessionId);
      if (session.currentTurnPromise) {
        try {
          await session.currentTurnPromise;
        } catch {
          // Closing a session owns the cleanup even when its turn failed.
        }
      }
      try {
        await adapter.closeSession(sessionId);
      } finally {
        sessionManager.deleteSession(sessionId);
      }
      if (cancellationError) throw cancellationError;
    })();
    closingSessions.set(sessionId, closing);
    void closing.finally(() => closingSessions.delete(sessionId)).catch(() => undefined);
    return closing;
  };

  agentApp.onRequest(acp.methods.agent.session.close, async (ctx) => {
    await closeManagedSession(ctx.params.sessionId);
    return {};
  });

  agentApp.onRequest(acp.methods.agent.session.delete, async (ctx) => {
    await closeManagedSession(ctx.params.sessionId);
    return {};
  });

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      const results = await Promise.allSettled(
        sessionManager.getSessions().map((session) => closeManagedSession(session.id)),
      );
      await adapter.dispose();
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    })();
    return disposePromise;
  };

  return Object.assign(agentApp, { ready, dispose });
}
