# 剑来生图工作台架构

## 运行时

- 前端：React 19 + React Router Framework Mode + Vite + Tailwind CSS 4；BoardUI/React Aria 作为 AI 工作台主 UI 体系。
- 状态与表单：TanStack Query、React Hook Form、Zod；Motion 和 Lucide React 负责有目的动效与图标。
- 后端：Rust/Axum/Tokio 模块化单体，分层为 routes → handlers → services → repositories。
- 数据：SQLx + PostgreSQL；SQLite 仅在迁移和回滚期间保留。
- 媒体：OSS 保存原图、预览、模板和视频；Angie 托管静态资源并代理 API，systemd 管理服务。

## 数据流

浏览器 → React Router 页面 → TanStack Query/API client → Axum handler → service → SQLx repository/PostgreSQL；生成媒体经校验后上传 OSS，再以任务状态和授权 URL 返回。SSE 只传任务/对话事件，不把凭据或余额写入浏览器。

## 迁移边界

SQLite 导出 → 脱敏 fixture → PostgreSQL 幂等导入 → 双读/差异报告 → 最终备份与在途任务处理 → Angie/systemd 切换。任何校验、健康检查或恢复演练失败都回到旧 Rust/SQLite 发行版。
