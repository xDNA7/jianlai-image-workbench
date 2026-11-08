# 剑来生图工作台架构

## 运行时

- 前端：React 19 + React Router Framework Mode + Vite + Tailwind CSS 4；BoardUI/React Aria 作为 AI 工作台主 UI 体系。
- 状态与表单：TanStack Query、React Hook Form、Zod；Motion 和 Lucide React 负责有目的动效与图标。
- 后端：Rust/Axum/Tokio 模块化单体，分层为 routes → handlers → services → repositories。
- 数据：SQLx + PostgreSQL；SQLite 仅在迁移和回滚期间保留。
- 媒体：OSS 保存原图、预览、模板和视频；Angie 托管静态资源并代理 API，systemd 管理服务。
- 工具链：Node/Bun 精确版本由 `ui/.node-version`、`ui/.bun-version` 与
  `ui/package.json` 声明并检查；Rust 由 `server-rust/rust-toolchain.toml` 固定。

## 数据流

浏览器 → React Router 页面 → TanStack Query/API client → Axum handler → service →
兼容仓储 → SQLx/PostgreSQL。兼容仓储仍是同步调用边界，保留现有事务和账本锁；
静态 SQL 目录使用一次性只读方言转换表，动态 SQL 不缓存。当前并非全异步仓储。

生成媒体经校验后上传 OSS，再以任务状态和授权 URL 返回。SSE 传任务与对话事件，
客户端只接收该账户可见的额度和余额，不接收供应商凭据。

首页只使用 ChatApp；视频模块按需加载。API 数据由账户隔离的 Query 缓存持有，
本地 state 保存聊天流、草稿及交互状态。视频未确认提交的 key 和输入摘要保存在
账户隔离的 sessionStorage，通过认证接口按原 key 恢复；不保存提示词或图片。

OpenAPI 描述原始 wire 响应，生成类型与 Zod 边界校验配合，CI 检查生成漂移。
后端产生独立 request ID，JSON 日志不记录 URI、查询参数、Cookie 或请求 body。

## 迁移边界

PostgreSQL 已是生产主库。当前发布不做数据库 schema 迁移；先排空任务、备份并在
独立数据库恢复核验，再切换受控 release/current 代码与静态产物。

代码或代理回切继续使用当前 PostgreSQL，不能恢复旧 SQLite 或 PG 快照覆盖上线后
新写入的账务。旧 SQLite 引擎只保留为独立迁移/灾难恢复能力，不是日常自动回切路径。
发布目录完整性及原子链接操作见 `ops/native_release.py`；部署路径、凭据和生产
备份指针由私有运维环境提供，不能加入公开仓库。
