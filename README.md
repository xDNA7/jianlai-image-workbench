# 剑来生图工作台

面向文字生图、参考图编辑、模板和作品管理的在线创作工作台。当前主线使用 React 19 + React Router + Vite + Tailwind CSS，服务端使用 Rust/Axum/Tokio + SQLx，生产数据库为 PostgreSQL。

## 目录

- `ui/`：主 React 单页应用与浏览器测试
- `server-rust/`：Rust API、任务、媒体和管理服务
- `app/public/`：模板元数据与兼容静态资源
- `server-rust/migrations/`：数据库迁移

## 本地检查

```sh
cd ui
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
bun run build

cd ../server-rust
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test
```

真实服务配置、数据库、上传图片、发布目录和生成产物通过环境变量或本机部署配置提供，不放入仓库。
