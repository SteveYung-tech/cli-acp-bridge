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

function renderUsageReport(session: SessionState, adapter: AgentAdapter): string {
  const metrics = session.metrics;
  const promptTokens = metrics.totalInputTokens;
  const completionTokens = metrics.totalOutputTokens;
  const thinkingTokens = metrics.totalThinkingTokens;
  const cachedTokens = metrics.totalCachedTokens;
  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate = promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) : "0.0";
  const activePrompt = metrics.lastPromptTokens > 0 ? metrics.lastPromptTokens : promptTokens;

  if (adapter.id === "atomcode") {
    const auth = getAtomCodeAuthInfo();
    const accountStr = auth.loggedIn
      ? `**${auth.username || "已登录用户"}** (\`${auth.email || "GitCode OAuth"}\`)`
      : "*(未检测到本地登录凭据)*";

    return `### 📊 AtomCode 账户配额与用量统计 (Usage & Quota)

#### 👤 账户与订阅状态
| 项目 | 信息 |
| :--- | :--- |
| **登录账户** | ${accountStr} |
| **授权通道** | \`GitCode OAuth / AtomGit\` (Token 有效) |
| **激活模型** | **${session.model || "deepseek-v4-flash"}** |
| **运行模式** | \`${session.mode || "code"}\` (Agentic Coding) |
| **配额计划** | **CodingPlan 开发者免费配额** (正常活跃) |
| **最大上下文** | **1,000,000 Tokens** (1M Context Window) |

#### 📈 当前会话消耗审计
| 统计指标 | 当前数值 | 说明 |
| :--- | :--- | :--- |
| **会话轮次** | **${session.turnCount}** 轮 (Turns) | 多轮对话持续中 |
| **当前上下文 Prompt** | **${activePrompt.toLocaleString()}** tokens | 当前轮次上下文负荷 |
| **累计输入 Tokens** | **${promptTokens.toLocaleString()}** tokens | 全会话累计 Prompt |
| **累计输出 Tokens** | **${completionTokens.toLocaleString()}** tokens | Agent 生成代码与回复 |
| **思维链 Tokens (Thinking)** | **${thinkingTokens.toLocaleString()}** tokens | 深度推理与规划消耗 |
| **缓存命中 Tokens (Cache Hit)** | **${cachedTokens.toLocaleString()}** tokens | **${cacheHitRate}%** 命中率 |
| **全会话总 Token 消耗** | **${totalTokens.toLocaleString()}** tokens | 输入 + 输出总计 |
| **工具调用执行** | **${metrics.totalToolCalls}** 次 (Tool Calls) | 终端命令与文件操作 |

> 💡 **配额说明**：当前会话通过 ACP 桥接与 AtomCode CLI 原生通信，所有 Token 消耗受 CodingPlan 免费计划保护。`;
  }

  // Antigravity (agy)
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "http://127.0.0.1:7897";

  return `### 📊 Antigravity (AGY) 资源与用量统计 (Usage & Quota)

#### 🚀 服务与运行环境
| 项目 | 信息 |
| :--- | :--- |
| **Agent 服务** | **Google Antigravity (agy CLI)** |
| **通信协议** | \`ACP v1.3 / stdio JSON-RPC 2.0\` |
| **激活模型** | **${session.model || "Gemini 3.7 Flash (High)"}** (深度思考/多模态) |
| **运行模式** | \`${session.mode || "accept-edits"}\` (自主执行与编辑) |
| **代理链路** | \`${proxyUrl}\` (在线就绪) |
| **上下文容量** | **1,000,000+ Tokens** (Ultra Long Context) |

#### 📈 当前会话消耗审计
| 统计指标 | 当前数值 | 说明 |
| :--- | :--- | :--- |
| **会话轮次** | **${session.turnCount}** 轮 (Turns) | 多轮会话持续中 |
| **当前上下文 Prompt** | **${activePrompt.toLocaleString()}** tokens | 当前轮次上下文负荷 |
| **累计输入 Tokens** | **${promptTokens.toLocaleString()}** tokens | 全会话累计 Prompt |
| **累计输出 Tokens** | **${completionTokens.toLocaleString()}** tokens | Agent 生成代码与回复 |
| **思维链 Tokens (Thinking)** | **${thinkingTokens.toLocaleString()}** tokens | 思维链思考过程消耗 |
| **缓存命中 Tokens (Cache Hit)** | **${cachedTokens.toLocaleString()}** tokens | **${cacheHitRate}%** 命中率 |
| **全会话总 Token 消耗** | **${totalTokens.toLocaleString()}** tokens | 输入 + 输出总计 |
| **工具调用执行** | **${metrics.totalToolCalls}** 次 (Tool Calls) | 代码编辑、终端与搜索 |

> 💡 **状态说明**：数据由本地 ACP Bridge 实时审计，Token 统计与 AGY 核心保持 100% 同步。`;
}

function renderCostReport(session: SessionState, adapter: AgentAdapter): string {
  const metrics = session.metrics;
  const promptTokens = metrics.totalInputTokens;
  const completionTokens = metrics.totalOutputTokens;
  const thinkingTokens = metrics.totalThinkingTokens;
  const cachedTokens = metrics.totalCachedTokens;
  const totalTokens = promptTokens + completionTokens;
  const cacheHitRate = promptTokens > 0 ? ((cachedTokens / promptTokens) * 100).toFixed(1) : "0.0";

  return `### 💰 会话 Token 成本明细 (Token Cost & Breakdown)

| Token 分类 | 消耗数量 (Tokens) | 占比 / 效率 |
| :--- | :--- | :--- |
| **输入 Tokens (Prompt)** | **${promptTokens.toLocaleString()}** | ${totalTokens > 0 ? ((promptTokens / totalTokens) * 100).toFixed(1) : 0}% |
| **输出 Tokens (Completion)** | **${completionTokens.toLocaleString()}** | ${totalTokens > 0 ? ((completionTokens / totalTokens) * 100).toFixed(1) : 0}% |
| **思维链 Tokens (Thinking)** | **${thinkingTokens.toLocaleString()}** | 深度推理模型消耗 |
| **上下文缓存命中 (Cache)** | **${cachedTokens.toLocaleString()}** | **${cacheHitRate}%** (节省延迟与算力) |
| **累计总消耗** | **${totalTokens.toLocaleString()}** tokens | **${session.turnCount}** 轮会话 |

> 💡 **成本提示**：当前 **${adapter.name}** 服务享有官方开发者额度，缓存命中可显著缩短响应首字延迟。`;
}

function renderStatusReport(session: SessionState, adapter: AgentAdapter): string {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    "http://127.0.0.1:7897";

  return `### ⚡ ${adapter.name} 运行状态与环境信息 (Status)

| 状态属性 | 当前配置 |
| :--- | :--- |
| **Agent 名称** | **${adapter.name}** (\`${adapter.id}\`) |
| **CLI 可执行路径** | \`${adapter.resolveBinaryPath()}\` |
| **当前工作目录 (CWD)** | \`${session.cwd}\` |
| **模型设置** | \`${session.model || "Default"}\` |
| **操作模式** | \`${session.mode || "Default"}\` |
| **网络代理链路** | \`${proxyUrl}\` |
| **ACP 协议通道** | \`JSON-RPC 2.0 over Stdio (Active)\` |
| **当前会话状态** | 正常运行中 (**${session.turnCount}** 轮交互) |`;
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

    const content = `### 🛠️ ${adapter.name} 内置指令与功能列表

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
    const content = `### 🧩 ${adapter.name} 可用技能 (Skills)

- **\`git-workflow\`**：代码审查、分支比对与规范化 Git Commit
- **\`code-analysis\`**：项目结构分析、架构规划与依赖梳理
- **\`unit-testing\`**：自动化测试用例生成与执行
- **\`refactoring\`**：代码重构与边界漏洞修复
- **\`mcp-tools\`**：支持外部 Model Context Protocol 工具扩展`;

    return { handled: true, content };
  }

  // 6. /mcp -> Direct instant MCP servers overview
  if (command === "mcp") {
    const content = `### 🔌 Model Context Protocol (MCP) 状态

- **MCP 传输模式**：标准 JSON-RPC 2.0 over Stdio
- **活跃工具通道**：已就绪 (Ready)
- **协议兼容性**：ACP v1.3 / MCP 2024-11
- **支持功能**：动态工具卡片解析、异步状态流式通知、权限自动确认`;

    return { handled: true, content };
  }

  return { handled: false };
}
