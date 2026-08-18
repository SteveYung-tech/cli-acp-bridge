/**
 * High-performance Zero-Latency Stream & Event Parser for AtomCode & Antigravity ACP.
 * Bulletproof UTF-8 multi-byte preservation, robust ANSI stripping, and diagnostic tag routing.
 */

export interface ParsedEvent {
  type: "thought" | "tool_call_start" | "tool_call_end" | "text" | "status" | "tokens";
  content?: string;
  toolName?: string;
  toolInput?: any;
  toolResult?: string;
  toolCallId?: string;
  metrics?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
    thinkingTokens?: number;
  };
}

// Regex matching standard ANSI sequences, CSI, OSC, and cursor codes
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /(?:\x1B[@-Z\\-_]|[\x80-\x9A\x9C-\x9F]|(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~])/g;

// Control characters (excluding \t, \n, \r)
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x1B]/g;

export function cleanTerminalOutput(text: string): string {
  if (!text) return "";
  return text.replace(ANSI_REGEX, "").replace(CONTROL_CHAR_REGEX, "");
}

export const stripAnsi = cleanTerminalOutput;

/**
 * State machine parser delivering zero-latency token streaming while
 * cleanly routing Thinking, Tool Calls, and discarding diagnostics.
 */
export class AtomCodeStreamParser {
  private buffer: string = "";
  private mode: "TEXT" | "THINKING" = "TEXT";
  private currentToolIdCounter: number = 0;
  private currentActiveToolCallId: string | null = null;
  private rawAnsiBuffer: string = "";

  public parseChunk(chunk: string): ParsedEvent[] {
    // 1. Combine with any partial ANSI sequence from previous chunk
    const combined = this.rawAnsiBuffer + chunk;
    this.rawAnsiBuffer = "";

    // 2. Check if chunk ends with an incomplete ANSI sequence (e.g. "\x1b" or "\x1b[2")
    const lastEscIdx = combined.lastIndexOf("\x1b");
    let safeToClean = combined;
    if (lastEscIdx !== -1 && lastEscIdx >= combined.length - 16) {
      const candidate = combined.slice(lastEscIdx);
      if (!/[@-~]/.test(candidate.slice(1))) {
        // Incomplete sequence at end of chunk -> keep in rawAnsiBuffer
        this.rawAnsiBuffer = candidate;
        safeToClean = combined.slice(0, lastEscIdx);
      }
    }

    const clean = cleanTerminalOutput(safeToClean);
    this.buffer += clean;
    const events: ParsedEvent[] = [];

    while (this.buffer.length > 0) {
      if (this.mode === "THINKING") {
        const doubleNewlineIdx = this.buffer.indexOf("\n\n");
        const nextBracketIdx = this.buffer.indexOf("[");

        let stopIdx = -1;
        let nextAction: "TAG" | "EXIT_THINKING" | "CONTINUE" = "CONTINUE";

        if (nextBracketIdx !== -1 && (doubleNewlineIdx === -1 || nextBracketIdx < doubleNewlineIdx)) {
          stopIdx = nextBracketIdx;
          nextAction = "TAG";
        } else if (doubleNewlineIdx !== -1) {
          stopIdx = doubleNewlineIdx;
          nextAction = "EXIT_THINKING";
        }

        if (stopIdx === -1) {
          events.push({
            type: "thought",
            content: this.buffer,
          });
          this.buffer = "";
          break;
        }

        if (stopIdx > 0) {
          const thoughtChunk = this.buffer.slice(0, stopIdx);
          events.push({
            type: "thought",
            content: thoughtChunk,
          });
          this.buffer = this.buffer.slice(stopIdx);
        }

        if (nextAction === "EXIT_THINKING") {
          this.mode = "TEXT";
          this.buffer = this.buffer.replace(/^\n+/, "");
          continue;
        }

        const closeBracketIdx = this.buffer.indexOf("]");
        if (closeBracketIdx === -1) {
          if (this.buffer.length > 60) {
            events.push({ type: "thought", content: this.buffer });
            this.buffer = "";
          }
          break;
        }

        const tag = this.buffer.slice(0, closeBracketIdx + 1);
        if (
          tag.startsWith("[tool→") ||
          tag.startsWith("[tool←") ||
          tag.startsWith("[tokens") ||
          tag.startsWith("[done") ||
          tag.startsWith("[dev") ||
          tag.startsWith("[headless")
        ) {
          this.mode = "TEXT";
          continue;
        } else if (tag.startsWith("[thinking]")) {
          this.buffer = this.buffer.slice(closeBracketIdx + 1);
          continue;
        } else {
          events.push({ type: "thought", content: tag });
          this.buffer = this.buffer.slice(closeBracketIdx + 1);
          continue;
        }
      }

      // Mode === "TEXT"
      const bracketIdx = this.buffer.indexOf("[");
      if (bracketIdx === -1) {
        // Zero-Latency: stream out full text immediately!
        events.push({
          type: "text",
          content: this.buffer,
        });
        this.buffer = "";
        break;
      }

      // Emit everything before '[' immediately
      if (bracketIdx > 0) {
        const textChunk = this.buffer.slice(0, bracketIdx);
        events.push({
          type: "text",
          content: textChunk,
        });
        this.buffer = this.buffer.slice(bracketIdx);
      }

      // Check if bracket starts a known system/diagnostic tag
      const isSystemTag =
        this.buffer.startsWith("[tool→") ||
        this.buffer.startsWith("[tool←") ||
        this.buffer.startsWith("[tokens") ||
        this.buffer.startsWith("[done") ||
        this.buffer.startsWith("[dev") ||
        this.buffer.startsWith("[headless") ||
        this.buffer.startsWith("[thinking]");

      if (!isSystemTag) {
        // Ordinary text with bracket (e.g. Markdown link "[label]" or array "[item]")
        // Look for next bracket or newline to emit safely
        const nextBracket = this.buffer.indexOf("[", 1);
        if (nextBracket === -1) {
          events.push({ type: "text", content: this.buffer });
          this.buffer = "";
          break;
        } else {
          events.push({ type: "text", content: this.buffer.slice(0, nextBracket) });
          this.buffer = this.buffer.slice(nextBracket);
          continue;
        }
      }

      // Handle system tags
      const endLineOrBracket = this.findTagBoundary(this.buffer);
      if (endLineOrBracket === -1) {
        if (this.buffer.length > 120) {
          events.push({ type: "text", content: this.buffer });
          this.buffer = "";
        }
        break;
      }

      const tagSlice = this.buffer.slice(0, endLineOrBracket).trim();
      this.buffer = this.buffer.slice(endLineOrBracket);

      if (tagSlice.startsWith("[thinking]")) {
        this.mode = "THINKING";
        const afterTag = tagSlice.replace(/^\[thinking\]\s*/, "");
        if (afterTag) {
          events.push({ type: "thought", content: afterTag });
        }
      } else if (tagSlice.startsWith("[tool→")) {
        const toolStartMatch = tagSlice.match(/^\[tool→\s*([a-zA-Z0-9_\-]+)\]\s*(.*)$/);
        if (toolStartMatch) {
          const toolName = toolStartMatch[1];
          const rawInput = toolStartMatch[2].trim();
          this.currentToolIdCounter++;
          this.currentActiveToolCallId = `call_${Date.now()}_${this.currentToolIdCounter}`;

          let parsedInput: any = rawInput;
          try {
            if (rawInput.startsWith("{") || rawInput.startsWith("[")) {
              parsedInput = JSON.parse(rawInput);
            }
          } catch {
            parsedInput = { input: rawInput };
          }

          events.push({
            type: "tool_call_start",
            toolCallId: this.currentActiveToolCallId,
            toolName,
            toolInput: parsedInput,
          });
        }
      } else if (tagSlice.startsWith("[tool←")) {
        const toolEndMatch = tagSlice.match(/^\[tool←\s*([a-zA-Z0-9_\-]+)\]\s*(.*)$/);
        if (toolEndMatch) {
          const status = toolEndMatch[1];
          const resultInfo = toolEndMatch[2].trim();
          const callId = this.currentActiveToolCallId || `call_${this.currentToolIdCounter}`;

          events.push({
            type: "tool_call_end",
            toolCallId: callId,
            toolResult: `${status}: ${resultInfo}`,
          });
          this.currentActiveToolCallId = null;
        }
      } else if (tagSlice.startsWith("[tokens")) {
        const pMatch = tagSlice.match(/prompt=(\d+)/);
        const cMatch = tagSlice.match(/completion=(\d+)/);
        const caMatch = tagSlice.match(/cached=(\d+)/);
        events.push({
          type: "tokens",
          metrics: {
            inputTokens: pMatch ? parseInt(pMatch[1], 10) : 0,
            outputTokens: cMatch ? parseInt(cMatch[1], 10) : 0,
            cachedTokens: caMatch ? parseInt(caMatch[1], 10) : 0,
          },
        });
      } else if (
        tagSlice.startsWith("[done") ||
        tagSlice.startsWith("[dev") ||
        tagSlice.startsWith("[headless")
      ) {
        events.push({
          type: "status",
          content: tagSlice,
        });
      } else {
        events.push({
          type: "text",
          content: tagSlice,
        });
      }
    }

    return events;
  }

  private findTagBoundary(str: string): number {
    const newlineIdx = str.indexOf("\n");
    const bracketIdx = str.indexOf("]");

    if (str.startsWith("[tokens")) {
      if (newlineIdx !== -1) return newlineIdx + 1;
      return str.length;
    }

    if (
      str.startsWith("[done") ||
      str.startsWith("[dev") ||
      str.startsWith("[headless")
    ) {
      if (newlineIdx !== -1) return newlineIdx + 1;
      if (bracketIdx !== -1) return bracketIdx + 1;
      return str.length;
    }

    if (str.startsWith("[tool→") || str.startsWith("[tool←")) {
      if (newlineIdx !== -1) return newlineIdx + 1;
      return -1;
    }

    if (str.startsWith("[thinking]")) {
      return bracketIdx !== -1 ? bracketIdx + 1 : -1;
    }

    if (bracketIdx !== -1) return bracketIdx + 1;
    if (newlineIdx !== -1) return newlineIdx + 1;
    return -1;
  }

  public flush(): ParsedEvent[] {
    const events: ParsedEvent[] = [];
    if (this.rawAnsiBuffer.length > 0) {
      const clean = cleanTerminalOutput(this.rawAnsiBuffer);
      if (clean) this.buffer += clean;
      this.rawAnsiBuffer = "";
    }
    if (this.buffer.length > 0) {
      if (
        !this.buffer.startsWith("[tokens") &&
        !this.buffer.startsWith("[done") &&
        !this.buffer.startsWith("[dev") &&
        !this.buffer.startsWith("[headless")
      ) {
        events.push({
          type: this.mode === "THINKING" ? "thought" : "text",
          content: this.buffer,
        });
      }
      this.buffer = "";
    }
    return events;
  }
}
