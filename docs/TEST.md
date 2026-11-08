
## 本轮实现收敛回归

- 视频已接单但响应丢失：按账户与原 requestKey 核对；404 时仅允许同输入以原 key
  重试，修改输入不能另开未知收费任务；刷新可恢复已完成结果。
- Query：旧图库缓存刷新失败仍显示可重试状态；迟到 bootstrap 不覆盖任务新余额；
  图库、模板及额度按账户隔离。
- 契约：拒绝不合法状态及残缺作品数据；保留可空余额；CI 检查生成类型漂移。
- 发布原语：产物 SHA256、防篡改、重复目录、越界路径与同库代码回切。
- 浏览器服务只读取 `dist/frontend-e2e` 导出物，使用测试专用静态服务器。
  React Router 的 Vite preview 会读取共享 `build/client`，不能假设 VITE_OUT_DIR
  已隔离 preview；生产构建可能覆盖该目录并使懒加载资源失效。
- 测试夹具必须提供真实接口保证的 capabilities，不能放松生产 schema 来迁就残缺 mock。
- 固定 Gitleaks 下载遇官方 release HTTP 504 时使用同一官方 API asset；两条路径
  都强制相同 SHA256。主路径和 API 路径的改包拒绝用例在公开检查中执行。
