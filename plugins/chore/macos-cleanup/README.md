# macos-cleanup Plugin

为 Claude Code 提供 macOS 清理、磁盘空间回收和系统健康检查的安全工作流。

当前插件围绕 [Mole](https://github.com/tw93/mole) 的 `mo` CLI 构建，让 Claude 在处理“Mac 磁盘满了”“System Data 很大”“卸载 App 残留”“清理 node_modules / build 产物”等任务时，优先走可预览、可确认、可恢复的路径。

## 插件目标

这个插件的目标不是让 Claude 自动删除文件，而是让 Claude：

1. 识别 macOS 清理类请求应该使用 `mo`；
2. 先运行 dry-run / preview；
3. 摘要候选项、空间估算和风险点；
4. 在真正清理、卸载、purge、优化或修改配置前等待明确确认；
5. 避免默认使用不可恢复删除。

一句话总结：**macos-cleanup 是 Mac 清理任务的安全操作手册，不是自动清盘工具。**

## 前置依赖

需要本机安装 Mole：

```bash
brew install mole
```

安装后可验证：

```bash
mo --version
mo --help
```

插件不会自动安装 Mole。skill 只会在 `mo` 缺失时建议安装，除非用户明确要求，否则不应主动执行安装命令。

## 现有实现概览

当前实现由一个 skill 和若干 reference 文件组成：

```text
plugins/chore/macos-cleanup/
├── .claude-plugin/
│   └── plugin.json
├── README.md
└── skills/
    └── mole/
        ├── SKILL.md
        └── references/
            ├── commands.md
            ├── troubleshooting.md
            └── workflows.md
```

### `skills/mole/SKILL.md`

这是主入口文件，负责：

- 定义触发场景
- 保留核心安全规则
- 区分 destructive cleanup 和 system/config-changing 命令
- 规定 session check
- 把用户意图路由到具体 workflow
- 定义预览和完成后的报告格式
- 指向需要时才读取的 reference 文件

`SKILL.md` 有意保持精简，避免把所有 `mo` 子命令细节都塞进主上下文。

### `skills/mole/references/workflows.md`

放详细工作流，包括：

- 释放磁盘空间：`mo clean --dry-run` → `mo clean`
- 完整卸载 App：`mo uninstall --dry-run <app>` → `mo uninstall <app>`
- 清理旧项目产物：`mo purge --dry-run` → `mo purge`
- 清理安装包：`mo installer --dry-run` → `mo installer`
- 分析磁盘占用：`mo analyze`
- 查看系统健康：`mo status`
- 优化 macOS 服务：`mo optimize --dry-run` → `mo optimize`
- 管理 whitelist / purge paths / setup maintenance commands

### `skills/mole/references/commands.md`

放命令参考和版本差异说明，包括：

- Mole 1.39.1 实际 help 输出
- `clean` / `uninstall` / `purge` / `installer` / `optimize` / `analyze` / `status` 的常用参数
- README 与本机版本可能不一致的地方
- `-json` 与 `--json` 这类版本差异提示

### `skills/mole/references/troubleshooting.md`

放排障说明，包括：

- `mo` 缺失
- 命令语法与 README 不一致
- macOS 权限 / Full Disk Access / sudo
- Touch ID sudo
- operation logs
- whitelist 和 protected paths
- `mo purge --paths`
- permanent deletion 风险
- 隐私路径摘要规则

## 触发场景

这个插件的 `mole` skill 适合处理：

- “帮我清理 Mac”
- “磁盘满了 / disk full”
- “System Data 很大”
- “Mac 变慢了，看看资源占用”
- “卸载某个 App 并清理残留”
- “找出大文件 / 大目录”
- “清理旧的 node_modules / build / dist / target”
- “清理 dmg/pkg/zip 安装包”
- “优化 Finder / Dock / Spotlight / Launch Services”

## 安全边界

skill 默认要求：

1. **先预览**：优先运行 `--dry-run` 或 read-only 分析命令。
2. **再摘要**：只汇总必要路径，避免暴露无关个人文件名、项目名、App 名。
3. **再确认**：真正删除、卸载、purge、优化、更新或改配置前，需要明确确认。
4. **优先可恢复**：默认依赖 Mole 的 Trash 行为，不主动使用 `--permanent`。
5. **不绕过安全机制**：不使用 `rm -rf` 代替 Mole，也不强行跳过权限或交互确认。

重点风险命令包括：

```bash
mo clean
mo uninstall
mo purge
mo installer
mo remove
```

系统或配置变更命令包括：

```bash
mo optimize
mo touchid enable
mo completion
mo update
mo purge --paths
```

## 渐进性披露设计

这个插件刻意采用三层结构：

1. **metadata**：`name` + `description`，用于触发 skill。
2. **SKILL.md**：加载后提供核心安全规则、路由和报告格式。
3. **references/**：只有需要具体流程、参数或排障时才读取。

这样做可以避免每次触发 skill 都把完整命令手册塞进上下文，同时保证高风险操作的安全规则始终可见。

## 维护建议

修改这个插件时，优先遵守以下规则：

- 新增触发场景：优先改 `SKILL.md` frontmatter description。
- 新增安全硬约束：放在 `SKILL.md`，不要只放 reference。
- 新增具体命令参数：放在 `references/commands.md`。
- 新增操作步骤：放在 `references/workflows.md`。
- 新增排障经验：放在 `references/troubleshooting.md`。
- 发现 README 与本机 `mo --help` 不一致时，以本机 help 为准。

## 验证

修改后建议检查：

```bash
mo --version
mo --help
```

并验证插件结构：

```bash
find plugins/chore/macos-cleanup -maxdepth 5 -type f | sort
```

如果使用插件校验工具，应确认：

- `.claude-plugin/plugin.json` 存在
- `skills/mole/SKILL.md` frontmatter 有 `name` 和 `description`
- `SKILL.md` 引用的 reference 文件全部存在
- 没有把 destructive workflow 放到无需确认的路径里
