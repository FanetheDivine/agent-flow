# Changelog

## Unreleased

- fix：SDK result 超时未到达时，`ClaudeExecutor` finally 块兜底消费 `pendingCompleteResult` 并补发 `onComplete`，避免 Flow 永远卡在 running（token 统计会丢失）
- 移除预设工作流「简单任务」中失效的共享数据 key `current_task`
