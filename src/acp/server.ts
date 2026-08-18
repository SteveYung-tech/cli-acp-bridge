import * as acp from "@agentclientprotocol/sdk";
import type { AgentAdapter } from "../adapters/base.js";
import { SessionManager } from "../session/manager.js";
import { expandSlashCommand } from "../commands/prompt-templates.js";
import { handleLocalSlashCommand } from "../commands/local-handlers.js";

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

export function createAgentServer(adapter: AgentAdapter) {
  const sessionManager = new SessionManager();

  const agentApp = acp.agent({
    name: adapter.id + "-acp",
  });

  // 1. Initialize Handshake
  agentApp.onRequest(acp.methods.agent.initialize, async (_ctx) => {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
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
      configOptions: adapter.getAvailableConfigOptions(session),
    };
  });

  // 4. session/set_mode
  agentApp.onRequest(acp.methods.agent.session.setMode, async (ctx) => {
    const params = ctx.params as { sessionId: string; mode?: string };
    if (params?.sessionId && params.mode) {
      sessionManager.setSessionOption(params.sessionId, "mode", params.mode);
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

    const turnPromise = (async () => {
      try {
        const result = await adapter.executeTurn({
          cwd: session.cwd,
          prompt: expandSlashCommand(promptText),
          continueSession,
          model: session.model,
          mode: session.mode,
          provider: session.provider,
          signal: abortController.signal,
          onMetrics: async (delta) => {
            sessionManager.addMetrics(session.id, delta);
          },
          onThought: async (thought) => {
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_thought_chunk",
                  content: {
                    type: "text",
                    text: thought,
                  },
                },
              });
            } catch (err) {
              console.error("Failed to send thought chunk:", err);
            }
          },
          onChunk: async (chunk) => {
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: chunk,
                  },
                },
              });
            } catch (err) {
              console.error("Failed to send message chunk:", err);
            }
          },
          onToolStart: async (toolCallId, toolName, toolInput) => {
            try {
              await ctx.client.notify(acp.methods.client.session.update, {
                sessionId: session.id,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId,
                  title: `Execute: ${toolName}`,
                  kind: "execute",
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
        throw err;
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
  agentApp.onNotification(acp.methods.agent.session.cancel, (ctx) => {
    const params = ctx.params as { sessionId: string };
    if (params?.sessionId) {
      sessionManager.cancelSession(params.sessionId);
    }
  });

  return agentApp;
}
