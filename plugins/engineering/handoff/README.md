# Handoff Plugin

将当前对话压缩为 handoff 文档，供下一轮 session 中的新 agent 接续工作。

## 来源与出处

本 skill 源自 [mattpocock/skills](https://github.com/mattpocock/skills) 仓库：

| 字段 | 值 |
| --- | --- |
| 上游仓库 | [mattpocock/skills](https://github.com/mattpocock/skills) |
| 分支 | `main` |
| 上游路径 | `skills/productivity/handoff/SKILL.md` |
| 内容哈希 | `1a78d774f8a59db5daa6e65e20a6596872fa8cde769f9a6e3a09b678dd5ae8cc` |

上游原始文件：[handoff/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md)

## 为何纳入本仓库

上游 skill 以独立 skill 形式分发；本仓库将其 vendoring 为 `plugins/engineering/handoff`，目的是：

1. **适配自己的工作流** — 与 lkangd-skills marketplace 中的其他 engineering plugin 统一安装、启用和管理。
2. **便于调整效果** — 可在 `skills/handoff/SKILL.md` 中按需微调 handoff 文档结构、字段要求或 suggested skills 策略，而不依赖上游发布节奏。
3. **保持可追溯** — 通过 README 中的上游路径与内容哈希，方便对照原版、判断是否需要同步更新。

若上游有更新，可对比上述路径与哈希，再决定是否合并到本地版本。

## 插件目标

Handoff 不是替代 PRD、计划、ADR 或 issue 的正式交付物，而是**会话间的上下文桥梁**：

- 总结当前对话中的决策、进展与未决事项
- 指向已有 artifact（路径或 URL），避免重复抄写
- 建议下一轮 agent 应调用的 skills
- 脱敏 API key、密码、PII 等敏感信息
- 将 handoff 文档写入**用户 OS 的临时目录**，而非当前 workspace

若用户传入参数（`argument-hint: "What will the next session be used for?"`），将其视为下一轮 session 的重点，并据此调整文档侧重点。

## 目录结构

```text
plugins/engineering/handoff/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── handoff/
        └── SKILL.md
```

## 与上游的差异

当前 vendored 版本与上游 `1a78d774…` 内容一致，仅做 plugin 化包装：

- 增加 `# Handoff` 标题，与同仓库其他 skill 的排版习惯对齐
- 增加 `.claude-plugin/plugin.json` 与 marketplace 注册条目
- 增加本 README，记录来源与维护说明

核心行为规则（保存位置、suggested skills、引用 artifact、脱敏、参数语义）未改动。

## 维护建议

- **调整 handoff 效果**：优先修改 `skills/handoff/SKILL.md`
- **同步上游**：对比 [上游 SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/handoff/SKILL.md)，合并后更新 README 中的内容哈希
- **不要**把 handoff 文档默认写入 workspace，除非有意修改 skill 行为

## 作者

Curtis Liong (<lkangd@gmail.com>)

上游作者：Matt Pocock — 见 [mattpocock/skills](https://github.com/mattpocock/skills)
