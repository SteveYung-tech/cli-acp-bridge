/**
 * Expands slash commands with rich, structured prompts matching Claude Code and Codex templates.
 */
export function expandSlashCommand(rawPrompt: string): string {
  const trimmed = rawPrompt.trim();
  if (!trimmed.startsWith("/")) {
    return rawPrompt;
  }

  const firstSpaceIndex = trimmed.indexOf(" ");
  const command = (firstSpaceIndex === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpaceIndex)).toLowerCase();
  const args = firstSpaceIndex === -1 ? "" : trimmed.slice(firstSpaceIndex + 1).trim();

  switch (command) {
    case "commit":
      return `【Git Commit 指令】
请帮我审查当前代码变更并创建 Git Commit：
1. 运行 \`git status\` 和 \`git diff\` 查看所有已暂存和未暂存的修改。
2. 暂存所有相关的变更文件（\`git add\`）。
3. 根据 Angular / Conventional Commits 规范（如 feat:, fix:, refactor:, docs:, test:, chore:）生成清晰、规范的 Commit Message。${
        args ? `\n用户额外补充的提交说明/重点: "${args}"` : ""
      }
4. 执行 \`git commit -m "<Commit Message>"\` 完成提交。
5. 最终输出 Commit Hash 以及简要的提交总结。`;

    case "review":
      return `【代码质量与安全审查 (Code Review)】
请对当前工作区的所有未提交变更进行深度的代码审查：
1. 检查潜在的代码缺陷、逻辑漏洞和边界条件处理。
2. 评估代码的可读性、类型安全性与架构设计规范。
3. 检查是否有未清理的调试代码、硬编码秘钥或临时数据。${
        args ? `\n审查重点: "${args}"` : ""
      }
4. 给出具体的修改建议或重构方案。`;

    case "review-branch":
      return `【分支差异审查 (Branch Diff Review)】
请对比当前分支与基准分支（默认 main/master${args ? `，用户指定基准: ${args}` : ""}）的代码差异：
1. 运行 \`git diff ${args || "main"}...HEAD\`。
2. 总结本次分支开发的主要功能特性与变更范围。
3. 提示可能存在合并冲突或回归风险的代码点。`;

    case "init":
      return `【项目规范与结构初始化 (Project Init)】
请全面分析当前工程的项目结构与技术栈：
1. 识别核心编程语言、构建工具、包管理器和项目依赖。
2. 分析代码组织方式与开发规范。
3. 提供项目概览或生成/更新项目规则指引说明。${
        args ? `\n初始化偏好: "${args}"` : ""
      }`;

    case "compact":
      return `【上下文历史压缩 (Context Compaction)】
请总结并压缩当前会话的历史对话内容：
1. 提炼并保留已完成的关键决策、修改的文件列表及当前系统状态。
2. 清理冗余的中间工具输出与临时交互记录。
3. 输出一份精简的上下文摘要备忘录，以便后续继续高效对话。`;

    default:
      return rawPrompt;
  }
}
