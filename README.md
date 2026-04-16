# agent-flow

`Agent Flow` 被定义为 `Agent` 作为节点构成的有向图，此插件提供可视化构建和调用 `Agent Flow` 的能力。

## FlowRunState.status 状态说明

| 状态           | 说明         | 能否进行破坏性编辑 |
| -------------- | ------------ | ------------------ |
| `ready`        | 未启动       | ✅                 |
| `preparing`    | 启动中       | ❌                 |
| `chatting`     | AI 生成中    | ❌                 |
| `waiting-user` | 等待用户输入 | ✅                 |
| `completed`    | 完成         | ✅                 |
| `error`        | 出错         | ✅                 |

> **破坏性编辑** = 删除 agent 和删除连线（包括已有连线被破坏的情况）；节点位置调整、粘贴 agent 等非破坏性操作始终允许。
