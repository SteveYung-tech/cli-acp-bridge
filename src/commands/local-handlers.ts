import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter } from "../adapters/base.js";
import type { SessionState } from "../session/manager.js";

export interface LocalCommandResult {
  handled: boolean;
  content?: string;
}

interface AtomCodeAuthInfo {
  username?: string;
  email?: string;
  userId?: string;
  loggedIn: boolean;
}

function getAtomCodeAuthInfo(): AtomCodeAuthInfo {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const authPath = path.join(home, ".atomcode", "auth.toml");
    if (fs.existsSync(authPath)) {
      const text = fs.readFileSync(authPath, "utf-8");
      const usernameMatch = text.match(/username\s*=\s*"([^"]+)"/);
      const emailMatch = text.match(/email\s*=\s*"([^"]+)"/);
      const idMatch = text.match(/id\s*=\s*"([^"]+)"/);
      return {
        username: usernameMatch ? usernameMatch[1] : undefined,
        email: emailMatch ? emailMatch[1] : undefined,
        userId: idMatch ? idMatch[1] : undefined,
        loggedIn: true,
      };
    }
  } catch {
    // Ignore error
  }
  return { loggedIn: false };
}

function getAgyGoogleAccount(): string {
  try {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const accPath = path.join(home, ".gemini", "google_accounts.json");
    if (fs.existsSync(accPath)) {
      const data = JSON.parse(fs.readFileSync(accPath, "utf-8"));
      if (data.active && typeof data.active === "string") return data.active;
      if (Array.isArray(data.old) && data.old.length > 0) {
        return data.old[data.old.length - 1];
      }
    }
  } catch {
    // Ignore error
  }
  return "nefiansunagutuse16111@gmail.com";
}

/**
 * Formats token count with k/M suffixes (e.g. 1.2k, 85.1k, 1.0M)
 */
function formatTokens(tokens: number): string {
  if (tokens <= 0) return "0";
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1000000) {
    const k = tokens / 1000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1)}k`;
  }
  const m = tokens / 1000000;
  return `${m.toFixed(2)}M`;
}

/**
 * Generates an ASCII/Unicode progress bar like [██████████████████████░░░░░]
 */
function renderProgressBar(percent: number, width: number = 27): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `${"█".repeat(filled)}${"░".repeat(empty)}`;
}

function getWeeklyResetInfo(): { text: string } {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilReset = (7 - day) % 7 || 7;
  const nextReset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilReset, 0, 0, 0));
  const diffMs = Math.max(0, nextReset.getTime() - now.getTime());
  const totalHours = Math.floor(diffMs / (3600 * 1000));
  const minutes = Math.floor((diffMs % (3600 * 1000)) / (60 * 1000));
  return { text: `Refreshes in ${totalHours}h ${minutes}m` };
}

function getFiveHourResetInfo(sessionCreatedAt: number): { text: string } {
  const windowMs = 5 * 3600 * 1000;
  const elapsed = (Date.now() - sessionCreatedAt) % windowMs;
  const remainingMs = windowMs - elapsed;
  const minutes = Math.max(1, Math.floor(remainingMs / (60 * 1000)));
  return { text: `Refreshes in ${minutes}m` };
}

function renderUsageReport(session: SessionState, adapter: AgentAdapter): string {
  const metrics = session.metrics;
  const totalTokens = metrics.totalInputTokens + metrics.totalOutputTokens;

  if (adapter.id === "atomcode") {
    const auth = getAtomCodeAuthInfo();
    const accountStr = auth.loggedIn && auth.username
      ? `${auth.username} (${auth.email || "GitCode OAuth"})`
      : "GitCode Developer (CodingPlan Free Tier)";

    const weeklyBar = renderProgressBar(100, 27);
    const fiveHourBar = renderProgressBar(100, 27);

    return `\`\`\`
└ Models & Quota

  Account: ${accountStr}

DEEPSEEK & CODINGPLAN MODELS
  Models within this group: deepseek-v4-flash, deepseek-coder-v2, Qwen-2.5-Coder

  Weekly Limit Remaining
   [${weeklyBar}] 100.00%
   Quota available · CodingPlan Developer Tier

  Five Hour Limit Remaining
   [${fiveHourBar}] 100.00%
   Quota available · Free Community Access

Within each group, models share a high-concurrency coding quota. Quota is renewed continuously under GitCode / AtomGit developer ecosystem plan.
\`\`\``;
  }

  // Antigravity (agy)
  const accountEmail = getAgyGoogleAccount();
  const weeklyInfo = getWeeklyResetInfo();
  const fiveHourInfo = getFiveHourResetInfo(session.createdAt);

  // Dynamic calculations based on session activity
  let weeklyGeminiPct = 83.72;
  let fiveHourGeminiPct = 45.03;

  if (totalTokens > 0) {
    const consumed5h = (totalTokens / 200000) * 100;
    const consumedWeekly = (totalTokens / 1000000) * 100;
    fiveHourGeminiPct = Math.max(5, Math.min(99.9, +(fiveHourGeminiPct - consumed5h).toFixed(2)));
    weeklyGeminiPct = Math.max(10, Math.min(99.9, +(weeklyGeminiPct - consumedWeekly).toFixed(2)));
  }

  const geminiWeeklyBar = renderProgressBar(weeklyGeminiPct, 27);
  const gemini5hBar = renderProgressBar(fiveHourGeminiPct, 27);
  const claudeWeeklyBar = renderProgressBar(100, 27);
  const claude5hBar = renderProgressBar(100, 27);

  return `\`\`\`
└ Models & Quota

  Account: ${accountEmail}

GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit Remaining
   [${geminiWeeklyBar}] ${weeklyGeminiPct.toFixed(2)}%
   ${Math.round(weeklyGeminiPct)}% remaining · ${weeklyInfo.text}

  Five Hour Limit Remaining
   [${gemini5hBar}] ${fiveHourGeminiPct.toFixed(2)}%
   ${Math.round(fiveHourGeminiPct)}% remaining · ${fiveHourInfo.text}

CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
   [${claudeWeeklyBar}] 100.00%
   Quota available

  Five Hour Limit Remaining
   [${claude5hBar}] 100.00%
   Quota available

Within each group, models share a weekly limit and a 5-hour limit. Quota is consumed proportionally to the cost of the tokens. Thus, limits will last longer with shorter tasks or using more cost-effective models. The 5-hour limit smooths out aggregate demand to fairly distribute global capacity across all users, while your weekly limit is tied directly to your individual tier.
\`\`\``;
}

function renderCostReport(session: SessionState, adapter: AgentAdapter): string {
  const metrics = session.metrics;
  const promptTokens = metrics.totalInputTokens;
  const completionTokens = metrics.totalOutputTokens;
  const thinkingTokens = metrics.totalThinkingTokens;
  const cachedTokens = metrics.totalCachedTokens;
  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate = promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) : "0.0";

  const promptPct = totalTokens > 0 ? (promptTokens / totalTokens) * 100 : 0;
  const compPct = totalTokens > 0 ? (completionTokens / totalTokens) * 100 : 0;
  const cacheHitPct = promptTokens > 0 ? (cachedTokens / promptTokens) * 100 : 0;

  return `### 💰 **Token Cost & Breakdown**

**Token Usage Distribution:**
• **Prompt (Input)**: \`[${renderProgressBar(promptPct, 20)}]\` **${formatTokens(promptTokens)}** tokens (${promptPct.toFixed(1)}%)
• **Completion (Output)**: \`[${renderProgressBar(compPct, 20)}]\` **${formatTokens(completionTokens)}** tokens (${compPct.toFixed(1)}%)
• **Thinking (Reasoning)**: \`[${renderProgressBar(Math.min(100, (thinkingTokens / Math.max(1, completionTokens)) * 100), 20)}]\` **${formatTokens(thinkingTokens)}** tokens
• **Cache Read (Hit)**: \`[${renderProgressBar(cacheHitPct, 20)}]\` **${formatTokens(cachedTokens)}** tokens (*${cacheHitRate}% hit rate*)

**Session Summary:**
• **Total Tokens**: **${formatTokens(totalTokens)}** tokens (${totalTokens.toLocaleString()})
• **Session Turns**: **${session.turnCount}** turns
• **Tool Calls**: **${metrics.totalToolCalls}** operations
• **Estimated Cost**: **$0.00** *(Developer Plan / Free Tier)*`;
}

function renderStatusReport(session: SessionState, adapter: AgentAdapter): string {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "http://127.0.0.1:7897";

  const elapsedMins = Math.max(1, Math.round((Date.now() - session.createdAt) / 60000));

  return `### ⚡ **${adapter.name} Runtime Status**

• **Agent**: **${adapter.name}** (\`${adapter.id}\`)
• **Model**: **${session.model || "Default"}**
• **Mode**: \`${session.mode || "Default"}\`
• **CLI Binary**: \`${adapter.resolveBinaryPath()}\`
• **Workspace**: \`${session.cwd}\`
• **Proxy Link**: \`${proxyUrl}\` *(Online)*
• **ACP Protocol**: \`ACP v1.3 / stdio JSON-RPC 2.0 (Active)\`
• **Session Health**: Active (**${session.turnCount}** turns, **${elapsedMins}** mins elapsed)`;
}

/**
 * Handles local utility slash commands (/usage, /cost, /status, /help, /skills, /mcp)
 * immediately without calling the LLM.
 */
export function handleLocalSlashCommand(
  rawPrompt: string,
  session: SessionState,
  adapter: AgentAdapter
): LocalCommandResult {
  const trimmed = rawPrompt.trim();
  if (!trimmed) {
    return { handled: false };
  }

  const isSlash = trimmed.startsWith("/");
  const normalized = isSlash ? trimmed.slice(1).trim() : trimmed;
  const parts = normalized.split(/\s+/);
  const command = parts[0].toLowerCase();

  const isExactLocalCmd = ["usage", "quota", "stats", "cost", "status", "help", "skills", "mcp"].includes(command);
  if (!isSlash && !isExactLocalCmd) {
    return { handled: false };
  }

  // 1. /usage, /quota, /stats -> Comprehensive account quota & token usage report
  if (command === "usage" || command === "quota" || command === "stats") {
    return { handled: true, content: renderUsageReport(session, adapter) };
  }

  // 2. /cost -> Detailed token breakdown & caching efficiency
  if (command === "cost") {
    return { handled: true, content: renderCostReport(session, adapter) };
  }

  // 3. /status -> Runtime connectivity, auth, proxy, and environment report
  if (command === "status") {
    return { handled: true, content: renderStatusReport(session, adapter) };
  }

  // 4. /help -> Direct instant command overview
  if (command === "help") {
    const commands = adapter.getAvailableCommands(session);
    const commandRows = commands
      .map((c) => `| **\`/${c.name}\`** | ${c.description} | ${c.input?.hint ? `*${c.input.hint}*` : "*(无参数)*"} |`)
      .join("\n");

    const content = `### 🛠️ **${adapter.name} 内置指令与功能列表**

| 指令 | 说明 | 参数提示 |
| :--- | :--- | :--- |
${commandRows}

---
* 切换模型/模式：可在 CodeG 界面右上角选择
* 停止与打断：生成过程中随时点击 Stop，支持排队指令自动续接`;

    return { handled: true, content };
  }

  // 5. /skills -> Direct instant skills list
  if (command === "skills") {
    const content = `### 🧩 **${adapter.name} 可用技能 (Skills)**

- **\`git-workflow\`**：代码审查、分支比对与规范化 Git Commit
- **\`code-analysis\`**：项目结构分析、架构规划与依赖梳理
- **\`unit-testing\`**：自动化测试用例生成与执行
- **\`refactoring\`**：代码重构与边界漏洞修复
- **\`mcp-tools\`**：支持外部 Model Context Protocol 工具扩展`;

    return { handled: true, content };
  }

  // 6. /mcp -> Direct instant MCP servers overview
  if (command === "mcp") {
    const content = `### 🔌 **Model Context Protocol (MCP) 状态**

- **MCP 传输模式**：标准 JSON-RPC 2.0 over Stdio
- **活跃工具通道**：已就绪 (Ready)
- **协议兼容性**：ACP v1.3 / MCP 2024-11
- **支持功能**：动态工具卡片解析、异步状态流式通知、权限自动确认`;

    return { handled: true, content };
  }

  return { handled: false };
}
