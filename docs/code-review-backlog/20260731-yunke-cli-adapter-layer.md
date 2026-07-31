---
id: yunke-cli-adapter-layer
status: open
severity: minor
found: 2026-07-31
source: /code-review, round 1
target: ship-to-test workflow 未提交改动（ship-to-test-run.js 失败检测 + 断点续跑）
---

# yunke-cli 的输出解析与失败判定散落在业务脚本里，没有独立的适配层

## Problem

`plugins/engineering/my-workflows/scripts/ship-to-test-run.js` 里有三块纯粹属于
「yunke-cli 这个外部工具」的领域知识：

- `yunkeText()`（约 143 行）：拆 MCP 结果信封，取 `content[].text`。
- `FAIL_MARKERS` / `OK_MARKERS` / `UNSUPPORTED_ENV_RE`（约 155–180 行）：把 yunke-cli 的
  失败措辞编码成一组正则，用来弥补「业务失败时退出码仍然是 0」。
- `yunkeAction()`：上面两者的组合判定。

这些都写在 ship-to-test 的业务脚本里。FAIL_MARKERS 是一个开放列表：yunke-cli 换一种失败
措辞（例如把「创建mr失败」改成别的说法）时，这里会静默退回 `unsure`；而将来任何第二个包
yunke-cli 的脚本都必须重写同一套信封解析与标记表，两份实现必然漂移。

## Why deferred

目前只有 ship-to-test-run.js 一个消费方，为单一消费方抽公共模块属于提前抽象；本轮的目标是
先把「失败必须被感知」这条正确性补上。等出现第二个 Node 侧的 yunke-cli 消费方，或者
yunke-cli 提供了结构化的失败输出（例如 `--exit-on-failure` 或 result 里带 success 字段）
时再动，收益和方向都会更清楚。

## Suggested fix approach

1. 优先推动上游：给 yunke-cli 加「业务失败时退出码非 0」或在 JSON 结果里给出明确的
   `success` / `error` 字段。若能拿到，本地这套正则可以整体退化为兜底。
2. 否则在 `plugins/engineering/my-workflows/scripts/` 下建 `yunke.js`，导出
   `yunkeAction(args)` / `yunkeJson(args)` / 标记表，ship-to-test-run.js 只消费
   `{ ok, unsure, text, reason }`；新的失败措辞只在一处登记。
3. 「done」的标准：新增一种失败措辞时只需要改一个文件，且现有 9 个离线场景仍然全绿。

## Recommended tools

- `grep -n "FAIL_MARKERS\|yunkeText\|yunkeAction\|UNSUPPORTED_ENV_RE" plugins/engineering/my-workflows/scripts/*.js`
  找出全部使用点。
- 回归验证：本轮用的离线验收脚本（假 yunke-cli + 假 GitLab，9 个场景 37 条断言）思路可复用，
  重点覆盖「退出码 0 但输出是失败」「输出无法判定」两条路径。
- 真实抽样：`yunke-cli devops <子命令> --help` 与一次真实失败输出，确认新措辞是否已被标记表覆盖。
