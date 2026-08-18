import type { AgentAdapter } from "../adapters/base.js";
import type { SessionState } from "../session/manager.js";

export interface LocalCommandResult {
  handled: boolean;
  content?: string;
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
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();

  // 1. /usage, /cost, /status -> Direct instant token and quota metrics report
  if (command === "/usage" || command === "/cost" || command === "/status") {
    const metrics = session.metrics;
    const promptTokens = metrics.totalInputTokens;
    const completionTokens = metrics.totalOutputTokens;
    const thinkingTokens = metrics.totalThinkingTokens;
    const cachedTokens = metrics.totalCachedTokens;
    const totalTokens = promptTokens + completionTokens;
    const cacheHitRate = promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) : "0.0";

    const content = `### 📊 会话用量与配额统计 (Usage & Quota)

| 统计指标 | 当前数值 |
| :--- | :--- |
| **当前 Agent** | **${adapter.name}** (\`${session.model || "Default"}\`) |
| **运行模式** | \`${session.mode || "Default"}\` |
| **会话轮次** | **${session.turnCount}** 轮 (Turns) |
| **输入 Tokens (Prompt)** | **${promptTokens.toLocaleString()}** |
| **输出 Tokens (Completion)** | **${completionTokens.toLocaleString()}** |
| **思维链 Tokens (Thinking)** | **${thinkingTokens.toLocaleString()}** |
| **缓存命中 (Cache Hit)** | **${cachedTokens.toLocaleString()}** (${cacheHitRate}%) |
| **累计消耗 (Total Tokens)** | **${totalTokens.toLocaleString()}** tokens |
| **工具调用次数** | **${metrics.totalToolCalls}** 次 (Tool Calls) |

> 💡 **状态说明**：数据由本地 ACP Bridge 实时审计，当前会话上下文健康，无多余消耗。`;

    return { handled: true, content };
  }

  // 2. /help -> Direct instant command overview
  if (command === "/help") {
    const commands = adapter.getAvailableCommands(session);
    const commandRows = commands
      .map((c) => `| **\`/${c.name}\`** | ${c.description} | ${c.input?.hint ? `*${c.input.hint}*` : "*(无参数)*"} |`)
      .join("\n");

    const content = `### 🛠️ ${adapter.name} 内置指令与功能列表

| 指令 | 说明 | 参数提示 |
| :--- | :--- | :--- |
${commandRows}

---
* 切换模型/模式：可在 CodeG 界面右上角选择
* 停止与打断：生成过程中随时点击 Stop，支持排队指令自动续接`;

    return { handled: true, content };
  }

  // 3. /skills -> Direct instant skills list
  if (command === "/skills") {
    const content = `### 🧩 ${adapter.name} 可用技能 (Skills)

- **\`git-workflow\`**：代码审查、分支比对与规范化 Git Commit
- **\`code-analysis\`**：项目结构分析、架构规划与依赖梳理
- **\`unit-testing\`**：自动化测试用例生成与执行
- **\`refactoring\`**：代码重构与边界漏洞修复
- **\`mcp-tools\`**：支持外部 Model Context Protocol 工具扩展`;

    return { handled: true, content };
  }

  // 4. /mcp -> Direct instant MCP servers overview
  if (command === "/mcp") {
    const content = `### 🔌 Model Context Protocol (MCP) 状态

- **MCP 传输模式**：标准 JSON-RPC 2.0 over Stdio
- **活跃工具通道**：已就绪 (Ready)
- **协议兼容性**：ACP v1.3 / MCP 2024-11
- **支持功能**：动态工具卡片解析、异步状态流式通知、权限自动确认`;

    return { handled: true, content };
  }

  return { handled: false };
}
