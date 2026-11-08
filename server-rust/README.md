# 生图工作台 · Rust

生产后端为 Rust/Axum/Tokio + SQLx/PostgreSQL；前端为 `../ui/` 的 React Router Framework Mode SPA，独立由 Angie 提供。分层入口为 `src/routes.rs`、`handlers/`、`services/`、`repositories/`。

## 构建与检查

```sh
cargo fmt --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked
cargo build --release --locked
bash scripts/test-pg-business.sh
bash scripts/test-pg-import.sh
bash scripts/test-pg-export.sh
```

工具链与依赖分别固定于 `rust-toolchain.toml` 和 `Cargo.lock`。业务集成使用独立临时 PostgreSQL 数据库、本地上游/OSS mock 和真实 HTTP；`tests/postgres_http.py` 可通过 `JIANLAI_TEST_BINARY` 验证指定 release 二进制。它同时验证 96 条 SQL 目录、隔离、幂等、账务、媒体、恢复、管理和 SQLite 回退适配。不要让隔离测试读取生产凭据或同时写生产目录。

生产启动环境保持由 systemd 与 root-only 项目外配置管理，配置 `DATABASE_MODE=postgres` 和 `DATABASE_URL`。PostgreSQL 模式缺 URL 或数据库不可用时禁止静默回退 SQLite。单实例 PostgreSQL lease 与本地目录锁分别防止第二进程启动；lease 丢失禁止重连并退出，由 systemd 重启。

## 任务、媒体与计费

- 图片与视频分别最多四并发。排队超时释放预留，重启恢复全部已提交视频并受四并发限制；已运行视频恢复排队时不会误用新任务等待超时。
- 任务创建、预留、幂等指纹与结算采用事务和共享账本行锁；金额使用整数分，同账户/requestKey 唯一，参数不一致返回 `409`。
- 图片每张 30 分。成功图片原子落盘、完整解码检查并写入交付 journal，随后登记与结算；部分成功仅结算实际交付张数。用户隐藏已交付图片不会减免费用。
- 图片接口保留金额字段 `charged`（元）；视频任务使用 `chargedCents` 与 `reservedCents`（分），smoke 按真实接口分别校验。
- 视频为 MiniMax-H3，4–15 秒、每秒 120 分；成功后扣费，失败释放预留。首帧、下载临时文件和 OSS 生命周期保持原有规则。
- 用户图片可见期十四天，管理员保留三十天；用户隐藏与管理员永久删除分开。管理员登录、CSRF、充值幂等、模板任务和账户隔离均经过集成验证。
- 凭据只存在服务器私密配置，禁止写入源码、fixture 或验收报告。数据目录与 OSS 位置沿用，迁移的是数据库元数据，无需重传旧媒体。

## 发布与回切

前端在 `../ui/` 执行 Bun typecheck/lint/test/build 与 Playwright，通过 `deploy/publish-frontend.py` 验证 receipt 后发布静态目录。不得继续使用历史原生网页构建脚本发布新前端。

PostgreSQL 受控切换入口为 `deploy/cutover-postgres.py`。默认只读预检；`--apply` 验证二进制 SHA、证据和 git HEAD，再关闭任务入口、排空图片/视频/模板任务、停止进程、快照备份、单事务导入、九表摘要核验、pg_dump 与独立 pg_restore 演练，先维护态启动，再开放流量。

手动回切：

```sh
python3 deploy/cutover-postgres.py --rollback <发布回执的备份目录>
python3 deploy/cutover-postgres.py --apply --rollback <发布回执的备份目录>
```

已经开放 PostgreSQL 写入后，脚本必须先将最新主库导出到新 SQLite 并逐字段核验，才能恢复旧二进制与配置。导出/校验失败不允许恢复旧账本。停服务前排空超时会解除维护门，保留当前主库。`deploy/switch.py`、`rollback.py` 是历史 Node→Rust/SQLite 工具，不用于 PostgreSQL 回切。

公网 smoke 默认不付费；明确传入 `--paid-image --paid-video` 才创建一张 30 分图片与一段四秒 480 分视频。测试凭据仅驻留内存，报告不含 Cookie。正式发布记录、备份目录与完整 SHA 由部署系统在仓库外维护。
