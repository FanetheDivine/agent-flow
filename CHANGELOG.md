# Changelog

## v0.0.72

- feat: Code 节点支持为 flow 指定 cwd（工作目录）；返回值新增 `cwd` 字段，直接写入 FlowRunState.cwd 驱动下一跳
- feat: LinkBlock 支持 `filename:startLine-endLine` 行范围格式（正则扩展为 `/^(.+):(\d+)(?:-(\d+))?$/`）
- 优化权限卡片：增加 loading 状态
