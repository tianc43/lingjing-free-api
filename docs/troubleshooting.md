# 故障排查

所有命令都只检查状态或元数据，不打印 Cookie、CSRF、下游密钥、Prompt 或数据库内容。以下示例假设调用进程已经安全设置 `LINGJING_API_KEY`。

## 会话过期：`lingjing_session_expired`

先检查文件存在、权限和修改时间：

```powershell
Get-Item -LiteralPath .\data\auth\storage-state.json, .\data\auth\session-profile.json |
  Select-Object Name, Length, LastWriteTime
```

停止服务写入竞争，在本机刷新会话再启动：

```powershell
docker compose stop
npm run login
docker compose up -d --wait
curl.exe -sS http://127.0.0.1:8000/v1/session -H "Authorization: Bearer $env:LINGJING_API_KEY"
```

`logged_in: true` 只说明存在 CSRF，不保证账号接口、余额或模型目录一定可用；再调用 `/token/check`。

## 账号状态：`needs_login`

`legacy` 使用 `data/auth`；新增账号使用 `data/accounts/<account-id>`。在管理控制台复制账号的固定登录命令，在本机完成登录：

```powershell
npm run login -- --account-id acct_0123456789abcdef01234567
```

然后只检查文件元数据，不读取会话内容：

```powershell
Get-ChildItem -LiteralPath .\data\accounts\acct_0123456789abcdef01234567 |
  Select-Object Name, Length, LastWriteTime
```

回到 `/admin/` 对该账号执行“检查”；健康变为 ready 后再启用。若仍是 `needs_login`，确认命令中的账号 ID 与控制台一致、目录对当前用户可写，并确认 `LINGJING_DATA_DIRECTORY` 指向同一个 `data` 根目录。不要复制 `legacy` 会话给另一个账号，也不要通过网页 API 上传 Cookie。

## CSRF 失效：`lingjing_csrf_expired`

读取类请求会自动使缓存失效并重载一次会话；持续失败时不要复制或打印 CSRF。按上节执行 `npm run login`。确认系统时间正确，并检查文件元数据：

```powershell
Get-Date
docker compose exec lingjing-free-api stat /app/data/auth/storage-state.json /app/data/auth/session-profile.json
```

## 模型目录变化：`model_catalog_changed`

强制刷新公开目录，不复用旧的 model id 或动态参数：

```powershell
curl.exe -sS "http://127.0.0.1:8000/v1/models?type=image&refresh=true" -H "Authorization: Bearer $env:LINGJING_API_KEY"
curl.exe -sS "http://127.0.0.1:8000/v1/models?type=video&mode=image-to-video&refresh=true" -H "Authorization: Bearer $env:LINGJING_API_KEY"
```

按返回的 `parameters`、`capabilities` 和 `pricing` 重建请求。如果网页端也已变化，停止真实生成，先更新逆向 fixture 和契约。

## 点数不足：`lingjing_insufficient_points`

只读查询脱敏余额：

```powershell
curl.exe -sS http://127.0.0.1:8000/v1/account -H "Authorization: Bearer $env:LINGJING_API_KEY"
```

不要自动充值或重提。对比网页端点数流水、模型公开 pricing 与预计次数；usage 为 0 不表示生成免费。

## 预算耗尽或没有可用账号

管理控制台中的 usage 使用可信 quoted points，不使用余额差。`0` 表示不限额；有限预算按 `Asia/Shanghai` 的每日/月度窗口重置。新任务先占用 reserved，提交可能发生后转为 charged，只有可证明在上游提交前失败才 released。

如果生成在上传或提交前返回 429，先在 `/admin/` 检查账号是否启用、健康状态、daily/monthly limit、charged usage 和 reserved usage。不要为了绕过预算立即启用未登录账号或更换幂等键。修改预算后重新使用原请求；若存在 `unknown`，先按下节裁决。

## `unknown` 任务

`unknown` 表示系统不能证明提交是否成功，不表示“没有扣费”。保持原 `Idempotency-Key`，不要创建新键重提：

```powershell
curl.exe -sS "http://127.0.0.1:8000/v1/tasks?status=unknown&limit=100" -H "Authorization: Bearer $env:LINGJING_API_KEY"
curl.exe -sS http://127.0.0.1:8000/v1/tasks/JOB_ID -H "Authorization: Bearer $env:LINGJING_API_KEY"
```

等待配置的恢复窗口，同时人工核对灵境网页资产和点数流水。若仍无法唯一确认，保留 SQLite 备份与 job id，人工决定是否接受再次计费风险。

## Docker 文件权限

先检查容器身份和元数据，不查看文件内容：

```powershell
docker compose exec lingjing-free-api id
docker compose exec lingjing-free-api stat /app/data /app/data/auth /app/data/lingjing.db
```

容器使用 uid/gid 1000 的 `node` 用户。若 Linux bind mount 权限不匹配，在确认目标确实是本项目 `./data` 后，用一次性 root 容器修复：

```bash
docker compose run --rm --user 0 --entrypoint sh lingjing-free-api -c "chown -R 1000:1000 /app/data && chmod -R u=rwX,go= /app/data"
docker compose up -d --wait
```

Windows/macOS Docker Desktop 通常不需要 `chown`；不要对工作区根目录递归改权限。

## SQLite 与账号会话的组合备份和恢复

SQLite 在线一致性备份使用 bundled `better-sqlite3` backup API，命令不输出记录：

```powershell
docker compose exec lingjing-free-api node -e "const D=require('better-sqlite3');new D('/app/data/lingjing.db').backup('/app/data/lingjing-backup.sqlite').then(()=>process.exit(0),()=>process.exit(1))"
Get-Item -LiteralPath .\data\lingjing-backup.sqlite | Select-Object Name, Length, LastWriteTime
```

数据库备份完成后短暂停止服务，再把 `data/auth` 和 `data/accounts` 复制到操作者预先创建的、仓库外绝对路径；不要打印或单独传输其中的文件。以下命令只验证路径并复制文件，不会替你配置磁盘加密、ACL 或备份保留策略：

```powershell
docker compose stop lingjing-free-api
$projectRoot = (Resolve-Path -LiteralPath .).Path.TrimEnd('\')
$backupRoot = [IO.Path]::GetFullPath('D:\replace-with-presecured-backup-root\lingjing-2026-07-24')
if (-not [IO.Path]::IsPathFullyQualified($backupRoot) -or
    $backupRoot.StartsWith("$projectRoot\", [StringComparison]::OrdinalIgnoreCase) -or
    -not (Test-Path -LiteralPath $backupRoot -PathType Container)) {
  throw 'Choose an existing protected backup directory outside this repository'
}
Copy-Item -LiteralPath .\data\lingjing-backup.sqlite -Destination $backupRoot
Copy-Item -LiteralPath .\data\auth -Destination $backupRoot -Recurse
if (Test-Path -LiteralPath .\data\accounts) {
  Copy-Item -LiteralPath .\data\accounts -Destination $backupRoot -Recurse
}
docker compose start lingjing-free-api
```

该仓库外目录含可直接登录的秘密；运行命令前，操作者必须在存储层单独启用适合其环境的加密和访问控制，并负责保留与销毁策略。不能把备份提交 Git、上传工单或长期明文保存。恢复前先 `docker compose down`，保留当前数据的另一个可恢复副本，再同时恢复 SQLite、`auth` 和 `accounts`，检查宿主机权限并启动。随后登录管理控制台确认账号、预算、quoted usage 和任务绑定；对 `needs_login` 账号按前述固定命令重新登录。不要在服务写入时用普通文件复制替代 SQLite backup API。

## Docker 启动与健康

```powershell
docker compose config --quiet
docker compose up -d --wait
docker compose ps
docker compose logs --since 10m lingjing-free-api
```

健康为 `starting` 时通常是 SQLite 恢复尚未完成；持续不健康时检查 `.env` 是否存在、API key 是否至少 16 字符、会话文件权限和数据目录可写性。日志按设计脱敏，但分享前仍应人工审查。

全假 smoke：

```powershell
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --wait
docker compose -f docker-compose.yml -f docker-compose.test.yml down -v
```

smoke override 使用 internal 网络，不能访问京东云；它只证明镜像、会话文件解析、SQLite 启动和 `/healthz`，不证明真实账号可用。
