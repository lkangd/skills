# Rocky-Pal Plugin

为 Claude Code 提供自动注入的 Rocky 风格回复能力。

这个插件不是靠手动执行命令触发，而是通过 `UserPromptSubmit` hook 在每次用户发言时自动判断：

- 普通自然语言请求：注入 Rocky 风格约束
- 明确要求关闭 Rocky 风格：跳过注入
- 明确要求纯机器可解析输出（纯 JSON / 纯命令 / 纯补丁）：跳过注入

插件目标很简单：**只改外层语气，不改技术结论、安全标准和格式要求。**

## 现有实现概览

当前实现由两部分组成：

1. `hooks/user_prompt_submit.py`
   - 读取用户本轮输入
   - 判断是否需要跳过 Rocky 风格
   - 从 `skills/rocky-pal/SKILL.md` 提取风格约束
   - 向 `UserPromptSubmit` 事件返回 `additionalContext`

2. `skills/rocky-pal/SKILL.md`
   - 作为 Rocky 风格的单一规则来源
   - 定义硬约束、语气模式、词典、角色背景、降噪策略

对应的 hook 配置在 `hooks/hooks.json` 中：

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "python3 ${CLAUDE_PLUGIN_ROOT}/hooks/user_prompt_submit.py",
            "timeout": 20
          }
        ]
      }
    ]
  }
}
```

## 工作方式

### 1. 自动注入

每次用户发送消息时，`user_prompt_submit.py` 会读取事件 JSON，并提取当前 prompt。

默认情况下，插件会构造如下结构的 hook 返回值：

- `systemMessage`：随机的 Rocky 风格短句或符号串
- `hookSpecificOutput.additionalContext`：从 `SKILL.md` 提炼出来的紧凑版风格约束

其中 `additionalContext` 会优先提取这些章节：

- `执行流程`
- `不可破坏的硬约束`
- `风格模式（沉浸式）`
- `风格词典`
- `情绪归纳`
- `角色背景（用于稳定人设）`

如果技能文件读取失败，脚本会回退到内置的 `FALLBACK_POLICY`。

### 2. 跳过注入

以下情况不会应用 Rocky 风格：

#### 明确关闭风格

命中这类表达时直接返回空对象：

- `关闭洛基风格`
- `不要 rocky 风格`
- `disable rocky`
- `no rocky`
- `neutral style`
- `plain tone`

#### 明确要求纯机器格式

命中这类表达时也会跳过：

- `只要 json`
- `纯补丁`
- `严格机器可解析`
- `json only`
- `command only`
- `patch only`
- `unified diff only`
- `machine readable only`

这部分逻辑是当前实现里最重要的保护措施，保证插件不会污染：

- 自动化脚本输入
- 命令直出场景
- 纯补丁输出
- 结构化 JSON 响应

## 不可破坏的硬约束

这些约束来自 `skills/rocky-pal/SKILL.md`，也是 README 最该关注的部分：

1. **结果等价**：只改语气，不改技术判断和操作结论
2. **信息完整**：不能因为风格化丢步骤、丢前置条件、丢失败分支
3. **安全一致**：不能为了角色化降低安全与合规标准
4. **格式优先**：严格格式任务优先保证格式纯净

一句话总结：**Rocky-Pal 是包装层，不是逻辑层。**

## 目录结构

```text
plugins/persona/rocky-pal/
├── .claude-plugin/
│   └── plugin.json
├── hooks/
│   ├── hooks.json
│   └── user_prompt_submit.py
├── skills/
│   └── rocky-pal/
│       ├── SKILL.md
│       └── references/
│           ├── dictionary.md
│           └── lines.md
├── scripts/
│   └── bump_version.py
├── CHANGELOG.md
├── README.md
└── trigger_eval_set.json
```

## 关键文件说明

### `hooks/user_prompt_submit.py`

主要职责：

- 规范化用户输入
- 用正则匹配关闭条件和机器格式条件
- 读取技能文件并压缩为注入上下文
- 输出 Claude Code hook 需要的 JSON 结构

实现特点：

- 支持中英文关闭/绕过短语
- `systemMessage` 带随机性，减少每次注入完全一致
- 依赖 `CLAUDE_PLUGIN_ROOT`，未提供时回退到脚本相对路径推导

### `skills/rocky-pal/SKILL.md`

这是 Rocky 角色语气的规则源文件，当前内容包括：

- 触发边界
- 结果保持规则
- 语气压缩方式
- 词汇映射
- 角色背景
- 紧急场景下的临时降噪策略

如果要调风格，优先改这里，不要先改 Python 脚本。

### `trigger_eval_set.json`

这是一组触发评估样本，已经覆盖两类核心判断：

- 应触发
- 不应触发

适合在修改正则规则后做回归检查，确认：

- 自然语言问题仍然触发
- 纯 JSON / 纯命令 / 纯补丁场景仍然不会被污染

### `scripts/bump_version.py`

仓库里已经有版本提升脚本，用于：

- 计算新版本号
- 汇总 changelog
- 同步插件元数据
- 可选自动提交

不过这个脚本当前假定存在带版本字段的插件元数据文件；使用前先确认 `.claude-plugin` 下的发布元数据结构已经和脚本保持一致。

## 适用场景

推荐启用 Rocky-Pal 的场景：

- 日常问答
- 调试说明
- 需求总结
- 翻译
- 带解释的代码协作
- 面向人的自然语言交互

不应干扰的场景：

- 纯 JSON 输出
- 单行命令直出
- 纯 diff / patch
- 任何要求零额外文本的机器消费链路

## 调整风格时的建议

### 改语气，不改边界

优先修改：

- `skills/rocky-pal/SKILL.md`

谨慎修改：

- `hooks/user_prompt_submit.py` 里的正则绕过规则

原因很直接：

- 技能文件负责“怎么说”
- hook 脚本负责“什么时候说”

如果把这两层混在一起，后面很容易把纯格式输出污染掉。

### 新增绕过规则时

每次新增正则，都建议同步补充 `trigger_eval_set.json`，至少覆盖：

- 一个应跳过的正例
- 一个不该被误伤的反例

## 手动验证建议

修改后至少检查这几类输入：

### 应触发

- `你是谁？`
- `帮我解释这个报错`
- `总结一下这个需求`
- `翻译成中文`

### 不应触发

- `仅输出 JSON，不要任何额外文本`
- `返回一条 shell 命令，除了命令本身不要任何文字`
- `给我一个纯补丁，不能有解释`
- `关闭洛基风格，后面都用普通语气回答`

## 安装与使用

本插件当前目录已经包含完整实现文件。

如果要在 Claude Code 插件体系中使用，至少需要确保：

- 插件根目录可被 Claude Code 识别
- `hooks/hooks.json` 被正确加载
- `CLAUDE_PLUGIN_ROOT` 指向当前插件目录，或允许脚本使用相对路径回退
- 运行环境可执行 `python3`

## 作者

Curtis Liong (<lkangd@gmail.com>)
