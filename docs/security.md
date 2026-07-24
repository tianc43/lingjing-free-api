# 安全模型

## 凭据与数据分类

有三组完全不同的秘密：

1. 灵境网页会话：`storage-state.json` / `cookie.txt`、CSRF 和 `session-profile.json`。
2. 下游 API 密钥：`LINGJING_API_KEY`，只保护本适配器。
3. 管理员密码：`LINGJING_ADMIN_PASSWORD`，只用于 `/admin/` 登录。

三者不能互相替代或复用。不要把任何真实值写进 Git、Dockerfile、Compose、issue、截图或聊天。`.env` 与 `data/` 已排除版本控制；备份同样按秘密加密保存。生成 Prompt、输入媒体、结果 URL、余额和任务数据库也属于用户数据。

现有单账号安装在升级时保留 `data/auth`，并记录为 `legacy`；服务不会自动移动会话。新增账号使用服务生成的固定目录 `data/accounts/<account-id>/`，HTTP 客户端不能指定路径或上传认证文件。宿主机应把 `data/auth`、`data/accounts` 和 SQLite 限制为仅运行服务的账号可读写；不要让多个服务实例同时回写同一会话目录。

## 网络边界

默认 `HOST=127.0.0.1`；生产 Compose 只发布 `127.0.0.1:8000:8000`。不要改成 `0.0.0.0` 对公网直接暴露。必须跨机器使用时，优先使用 SSH 隧道，或在受控反向代理后提供 TLS、源地址限制、独立认证、限速与请求大小限制。Fastify 默认不信任代理头，也不启用 CORS。

生成路由和 OpenAPI 使用 Bearer 密钥；管理 UI 使用独立管理员 Cookie 和同源 CSRF。管理员会话只存内存，重启后必须重新登录。只有 `/healthz` 与 `/ping` 公开。该边界仍是单操作者边界，不提供下游多租户授权、RBAC 或资源隔离。

## SSRF 与上传

远程媒体只允许 `http:` / `https:`，拒绝 URL 用户信息、本机、私网、链路本地、文档网段、保留地址和非全局 IPv6。DNS 解析结果固定到连接，重定向逐跳重验且最多 3 次。响应必须为匹配的 image/video MIME，并受 Content-Length、流式字节、单请求和全局临时空间限制。

对象存储 signed URL 只接受 HTTPS、无 URL 用户信息、非灵境 origin、已由 init 响应登记且尚未消费的 URL。发送 signed PUT 时显式移除 Cookie、Authorization、CSRF、Origin 与 Referer。

这些防护降低 SSRF 风险，但不是沙箱替代品；仍应在最小权限主机/容器和受控出站网络中运行。

## 日志

默认日志不会记录请求体。序列化器会移除查询串，脱敏 Authorization、Cookie、Set-Cookie、CSRF、`originPin`、storage state、Prompt、媒体列表与嵌套 cause；错误只保留安全 code。不要把日志级别调高后假设第三方库也一定脱敏，也不要上传原始 core dump 或数据目录。

排障时只查看文件存在性、大小、修改时间、权限和 API 的脱敏状态；禁止用 `cat`、`type`、`Get-Content` 或 `docker compose exec ... env` 输出凭据。

## Docker

镜像是 Node 20.19 multi-stage build：构建阶段同时生成服务器和 `dist/admin` 静态资源，测试在镜像外运行，runtime 只包含 production dependencies，进程为内置 `node` 用户。Compose：

- 只把 `/app/data` 用作凭据、SQLite 和临时文件的持久化挂载；
- drop 全部 Linux capabilities；
- 设置 `no-new-privileges:true`；
- loopback 发布端口；
- 不内联 Cookie 或真实凭据。

确保宿主机 `./data` 只对运行 Docker 的账号可读写。`LINGJING_DATA_DIRECTORY=/app/data`、数据库和所有账号会话必须保持在同一持久化挂载中。Docker smoke override 的 fixture 全假且只读，数据卷可随 `down -v` 删除，并连接 internal 网络以阻断京东云流量；它不得替代真实生产配置。

## 备份边界

一个可恢复备份必须同时包含：

- SQLite 主库的一致性备份，其中保存账号配置、预算、quoted usage 和任务绑定；
- `data/auth` 中 `legacy` 会话；
- `data/accounts` 中新增账号的会话目录。

只备份数据库会丢失登录状态，只备份会话会丢失预算和任务绑定。SQLite 在线备份完成后，应短暂停止服务写入再复制会话目录，或在服务完全停止时整体复制 `data/`。备份包含可直接登录的秘密，必须加密、限制访问并按轮换策略销毁旧副本。恢复后先检查文件所有权与权限，再启动并通过管理控制台确认 `needs_login`、账号预算和任务绑定。

## 轮换

下游 API 密钥轮换：

1. 生成新的随机值并只写入 `.env` 或秘密管理器，不打印到终端。
2. 重启服务；现有调用方立即改用新密钥。
3. 确认旧密钥返回 401 后，从调用方安全存储中删除。

管理员密码轮换：

1. 生成独立强密码并只写入环境变量或秘密管理器。
2. 重新创建或重启容器；内存中的旧管理员会话随进程结束失效。
3. 确认旧密码无法登录，并保留 loopback 或受控代理边界。

灵境会话轮换：

1. `legacy` 在本机执行 `npm run login`；新增账号执行 `npm run login -- --account-id <id>`。
2. 只确认对应会话目录中文件的修改时间、所有权和权限已更新，不查看内容。
3. 重启容器/本地服务并调用 `/v1/session`、`/token/check`。
4. 删除不再使用的加密备份；若怀疑泄漏，同时在灵境侧退出其他会话或修改账号凭据。

不要把会话文件挂给多个并发写入者；Set-Cookie 回写和登录刷新应由单一实例完成。
