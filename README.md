# cli-acp-bridge (AtomCode & Antigravity ACP)

> **Native-grade Agent Client Protocol (ACP) Adapter for AtomCode CLI and Antigravity (agy)**
>
> 专为 **CodeG** 与 **Zed** 设计的标准 ACP 协议桥接服务，让 **AtomCode** 和 **Antigravity (agy)** 获得与原生 Codex、Claude Code 一致的沉浸式体验。

```text
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CodeG UI Experience                                     │
│  • Agent Picker: @Atom  /  @Antigravity                                                   │
│  • Model Selector: DeepSeek V4 Flash / Gemini 3.7 Flash / Gemini 3.1 Pro / Claude 3.7 Sonnet│
│  • Mode Selector: Code / Plan / Architect / Ask                                           │
│  • 实时折叠思考气泡 (agent_thought_chunk)                                                 │
│  • 实时交互式工具卡片 (tool_call / tool_call_update)                                      │
│  • 原生级打断插话与排队恢复 (Non-destructive Prompt Queueing)                             │
│  • 多轮会话上下文自动延续 (Multi-turn Context Persistence)                                │
└───────────────────────────────┬───────────────────────────────────┬───────────────────────┘
                                │                                   │
                    JSON-RPC 2.0 (stdio)                JSON-RPC 2.0 (stdio)
                                │                                   │
                                ▼                                   ▼
                    ┌───────────────────────┐           ┌───────────────────────┐
                    │     atomcode-acp      │           │        agy-acp        │
                    │  (AtomCode ACP Server)│           │   (AGY ACP Server)    │
                    └───────────┬───────────┘           └───────────┬───────────┘
                                │                                   │
                                ▼                                   ▼
                    ┌───────────────────────┐           ┌───────────────────────┐
                    │     AtomCode CLI      │           │   Antigravity (agy)   │
                    │    (atomcode.exe)     │           │       (agy.exe)       │
                    └───────────────────────┘           └───────────────────────┘
```

---

## 🌟 核心功能特性

1. **持久后端与增量流式输出**：AtomCode 在每个 ACP 进程内复用一个私有 daemon；AGY 在每个 ACP 会话内复用一个 `stream-json` worker。提示词不再为每轮重复启动 CLI，文本事件到达后立即转发，不做适配器批处理。
2. **原生折叠思考流（Thinking Bubble）**：深度提取思维链并实时封装为 `agent_thought_chunk`。
3. **打断插话与排队发送（Prompt Queue & Interruption）**：在生成过程中发送新指令并点击 Stop 时，优雅打断并自动无缝发送排队消息，与 Codex 原生体验一致。
4. **模型与模式热切换**：
   * **AtomCode**：默认跟随 `~/.atomcode/config.toml` 的 `default_provider`，也可选择已配置的 AtomGit provider；支持 `code` / `architect` / `ask` 模式。
5. **斜杠指令系统（Slash Commands）**：输入 `/` 即可唤出 Agent 内置快捷指令菜单：
   * **AtomCode**：`/plan`（任务规划）、`/review`（代码审查）、`/test`（生成测试）、`/init`（项目初始化）、`/compact`（历史压缩）、`/help`（帮助说明）。
   * **Antigravity (agy)**：`/plan`（分步规划）、`/grill-me`（深度需求对齐）、`/learn`（沉淀知识/规则）、`/research`（启动调研子代理）、`/review`（Diff 审查）、`/compact`（上下文压缩）、`/help`（指南）。
6. **内置代理路由**：默认自动注入本地代理节点 `http://127.0.0.1:7897`，解决 Google 认证与模型网络握手问题。

### 首字延迟诊断

设置 `ACP_TIMING=1` 后，桥接器会把 `prompt_received`、后端就绪/接收、`first_event`、`first_thought`、`first_text` 和 `turn_completed` 的耗时记录写入 stderr。ACP 的 JSON-RPC stdout 不会混入诊断内容。

```powershell
$env:ACP_TIMING="1"
atomcode-acp
```

`npm test` 只使用仓库内的确定性假后端，不访问模型服务，也不消耗额度。`npm run test:live:atomcode` 和 `npm run test:live:agy` 才会使用本机已配置的真实后端与供应商访问权限。

---

## 🐧 Linux / CachyOS (Arch Linux) 部署指南

### 1. 复制或克隆工程
将工程放置在用户目录，例如：
```bash
git clone <your-repo-url> ~/atomcode-acp
# 或直接复制到 ~/atomcode-acp
cd ~/atomcode-acp
```

### 2. 编译并全局软链命令
```bash
# 安装依赖并编译
npm install
npm run build

# 全局软链生成 atomcode-acp 与 agy-acp 命令
npm link
# 若全局 npm 路径受限，可执行: sudo npm link
```

**验证全局命令：**
```bash
which atomcode-acp   # 应当输出可执行文件路径
which agy-acp        # 应当输出可执行文件路径
```

### 3. 一键注册到 CachyOS 的 CodeG（推荐）
在 CachyOS 终端中直接运行以下命令，自动将 `@Atom` 与 `@Antigravity` 写入 CodeG 数据库：

```bash
python3 -c "
import sqlite3, os

db_candidates = [
    os.path.expanduser('~/.config/app.codeg/codeg.db'),
    os.path.expanduser('~/.config/codeg/codeg.db')
]
db_path = next((p for p in db_candidates if os.path.exists(p)), db_candidates[0])
os.makedirs(os.path.dirname(db_path), exist_ok=True)

conn = sqlite3.connect(db_path)
cur = conn.cursor()

# 注册 AtomCode
cur.execute('''INSERT OR REPLACE INTO custom_agent (id, registry_id, name, description, version, distribution_kind, spec_json, icon_url, created_at, updated_at, skills_shared_store, source, version_probe, supports_mcp) 
VALUES (2, 'atomcode', 'Atom', 'AtomCode AI via ACP', '1.0.0', 'npx', '{\"npx\":{\"package\":\"atomcode-acp\",\"args\":[],\"env\":{},\"cmd\":\"atomcode-acp\"}}', NULL, datetime('now'), datetime('now'), 1, 'manual', 'atomcode --version', 1)''')

# 注册 Antigravity (agy) - 绑定 7897 代理端口
cur.execute('''INSERT OR REPLACE INTO custom_agent (id, registry_id, name, description, version, distribution_kind, spec_json, icon_url, created_at, updated_at, skills_shared_store, source, version_probe, supports_mcp) 
VALUES (3, 'antigravity', 'Antigravity', 'Antigravity AI via ACP', '1.0.0', 'npx', '{\"npx\":{\"package\":\"atomcode-acp\",\"args\":[],\"env\":{\"HTTP_PROXY\":\"http://127.0.0.1:7897\",\"HTTPS_PROXY\":\"http://127.0.0.1:7897\"},\"cmd\":\"agy-acp\"}}', NULL, datetime('now'), datetime('now'), 1, 'manual', 'agy --version', 1)''')

conn.commit()
print('✅ CachyOS CodeG Agent 注册完成！')
"
```

### 4. 运行端到端验证
```bash
# 非计费自动化测试（同时覆盖 AtomCode 与 AGY）
npm test

# 可选：真实后端验证，会消耗已配置的供应商访问权限
npm run test:live:atomcode
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 npm run test:live:agy
```

---

## 🪟 Windows 部署指南

### 1. 编译并全局软链命令
在 PowerShell 中运行：
```powershell
cd E:\atomcode-acp
npm install
npm run build
npm link
```

### 2. 一键注册到 Windows 的 CodeG
在 PowerShell 中运行：
```powershell
python -c "import sqlite3; conn = sqlite3.connect(r'C:\Users\Admin\AppData\Roaming\app.codeg\codeg.db'); cur = conn.cursor(); cur.execute('''INSERT OR REPLACE INTO custom_agent (id, registry_id, name, description, version, distribution_kind, spec_json, icon_url, created_at, updated_at, skills_shared_store, source, version_probe, supports_mcp) VALUES (2, 'atomcode', 'Atom', 'AtomCode AI via ACP', '1.0.0', 'npx', '{\x22npx\x22:{\x22package\x22:\x22atomcode-acp\x22,\x22args\x22:[],\x22env\x22:{\x22ATOMCODE_PATH\x22:\x22C:\\\\Users\\\\Admin\\\\AppData\\\\Local\\\\AtomCode\\\\atomcode.exe\x22},\x22cmd\x22:\x22atomcode-acp\x22}}', 'E:/atomcode-acp/assets/atomcode.jpg', datetime('now'), datetime('now'), 1, 'manual', 'atomcode --version', 1)'''); cur.execute('''INSERT OR REPLACE INTO custom_agent (id, registry_id, name, description, version, distribution_kind, spec_json, icon_url, created_at, updated_at, skills_shared_store, source, version_probe, supports_mcp) VALUES (3, 'antigravity', 'Antigravity', 'Antigravity AI via ACP', '1.0.0', 'npx', '{\x22npx\x22:{\x22package\x22:\x22atomcode-acp\x22,\x22args\x22:[],\x22env\x22:{\x22AGY_PATH\x22:\x22C:\\\\Users\\\\Admin\\\\AppData\\\\Local\\\\agy\\\\bin\\\\agy.exe\x22,\x22HTTP_PROXY\x22:\x22http://127.0.0.1:7897\x22,\x22HTTPS_PROXY\x22:\x22http://127.0.0.1:7897\x22},\x22cmd\x22:\x22agy-acp\x22}}', 'E:/atomcode-acp/assets/antigravity.jpg', datetime('now'), datetime('now'), 1, 'manual', 'agy --version', 1)'''); conn.commit(); print('Windows CodeG Agent 注册成功!')"
```

### 3. 运行端到端验证
```powershell
# 非计费自动化测试（同时覆盖 AtomCode 与 AGY）
npm test

# 可选：真实后端验证，会消耗已配置的供应商访问权限
npm run test:live:atomcode
$env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"; npm run test:live:agy
```

---

## 🎨 资源图标 (Assets)

* AtomCode 图标：[`assets/atomcode.jpg`](file:///E:/atomcode-acp/assets/atomcode.jpg)
* Antigravity 图标：[`assets/antigravity.jpg`](file:///E:/atomcode-acp/assets/antigravity.jpg)

---

## 📜 许可证

MIT License
