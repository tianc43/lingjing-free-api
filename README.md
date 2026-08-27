# Lingjing Free API

把一个或多个已登录的灵境网页订阅组成可调度账号池，对外提供项目隔离的文生视频、图生视频和兼容图片 API，并配套 User、Project、Plan、API Key、Usage、Webhook 与同源管理控制台。

## 项目边界

本项目调用的是灵境网页端接口，不是京东云官方开放 API，也不代表官方支持的集成方式。**订阅不等于官方 API**：网页会员、点数或套餐只说明账号可在网页产品中使用相应能力，不会自动获得稳定的 API 合约、SLA、商用授权或免额外计费。网页接口、字段、模型目录和风控规则可能随时变化，详见 [docs/protocol.md](docs/protocol.md)。

请遵守服务条款、内容规范和所在地法律。每次生成都可能消耗真实点数；本项目不会绕过计费、权限或内容审核。当前部署仍面向可信机器上的**单管理员**（管理平面仍是单用户），但下游调用已按 User → Project → API Key 隔离；它不是公网计费 SaaS，也尚未提供 RBAC、支付或官方 SLA。

## 环境要求

- Node.js **20.19.3**（最低兼容范围为 `>=20.19.0`）
- npm 10
- Chromium（只用于本机交互式登录）
- 可选：Docker Engine 与 Docker Compose v2

## 本地安装、登录与刷新会话

```bash
npm ci
npx playwright install chromium
cp .env.example .env
node -e "const fs=require('fs'),crypto=require('crypto');const p='.env';let s=fs.readFileSync('.env.example','utf8');s=s.replace('LINGJING_API_KEY=change-me',['LINGJING_API_KEY',crypto.randomBytes(32).toString('hex')].join('='));fs.writeFileSync(p,s,{mode:0o600})"
npm run login
```

Windows PowerShell 可用 `Copy-Item .env.example .env` 代替 `cp`；密钥生成命令不会把密钥打印到终端。`LINGJING_API_KEY` 是调用本适配器的下游 Bearer 密钥，不是灵境 Cookie 或官方 API Key。

`npm run login` 会从 `.env` 读取路径，打开本机 Chromium。CLI 登录仅用于 legacy 或既有账号会话兼容。完成灵境登录后，它原子写入：

- `data/auth/storage-state.json`：Playwright Cookie 状态；
- `data/auth/session-profile.json`：账号定位所需的最小配置。

浏览器登录只能在本机运行，版本一 Docker 镜像内不包含登录 GUI。既有 CLI 会话过期、CSRF 失效或切换账号时，在停止写入竞争后重新执行对应登录命令；服务会在下次加载时采用新文件。

首次升级会把现有 `data/auth` 记录为 `legacy` 账号，不移动或重写会话文件。新增账号应使用管理控制台的 Cookie 导入流程。

## 配置与启动

`.env.example` 列出全部限制、超时和路径。至少确认：

```dotenv
HOST=127.0.0.1
PORT=8000
# LINGJING_API_KEY 请使用上面的随机生成命令写入，不要手工填写或打印
SESSION_MODE=browser-state
```

本地运行：

```bash
npm run build
npm start
```

默认不开放接口文档。仅在可信本机临时设置 `DOCS_ENABLED=true` 后，可用同一 Bearer 密钥访问 `/docs/` 和 `/openapi.json`。

Docker 运行前，先在本机完成登录并保留 `./data/auth`，然后：

```bash
docker compose build
docker compose up -d --wait
docker compose ps
```

Windows PowerShell 的完整管理控制台启动流程如下。`change-me` 仅为扫描安全的占位符，实际运行前必须换成独立的强密码，且不能与 `LINGJING_API_KEY` 或灵境网页凭据复用：

```powershell
$env:LINGJING_ADMIN_PASSWORD = 'change-me'
docker compose up -d --build
Start-Process 'http://127.0.0.1:8000/admin/'
```

生产 Compose 的同一镜像包含 `dist/index.js` 与 `dist/admin`，只发布 `127.0.0.1:8000`，只把 `./data` 挂载到 `/app/data`，容器以非 root `node` 用户运行，并启用 `cap_drop: ALL` 与 `no-new-privileges`。`LINGJING_DATA_DIRECTORY=/app/data` 使 SQLite 之外的账号会话也落在该持久化挂载中。不要把 `docker-compose.test.yml` 用于生产；它只有全假凭据、隔离网络和可删除的 smoke 数据卷。

使用 MinIO 持久化输入资产：

```bash
cp .env.production.example .env.production
# 将所有 change-me 替换为独立强随机值
docker compose --env-file .env.production -f docker-compose.production.yml up -d --build --wait
```

可用隔离 MinIO 验证 Adapter 的 Put/Get/Range/Delete：先启动一个 S3-compatible Endpoint 并设置 `S3_ENDPOINT`、`S3_BUCKET` 与标准 AWS 凭据，再运行 `npm run test:minio`。

输出视频和 Poster 默认保留 7 天，可通过 `OUTPUT_RETENTION_MS` 调整；Maintenance 会删除过期对象，过期 Asset URL 返回 404。

PostgreSQL 模式需要设置 `DATABASE_DRIVER=postgres` 与 `DATABASE_URL`。当前 Compose 中 PostgreSQL 服务位于 `future-postgres` profile；启动完整依赖可使用 `docker compose --profile future-postgres --env-file .env.production -f docker-compose.production.yml up -d --build --wait`。切换前必须停止 API/Worker，先完成离线迁移，禁止 SQLite/PostgreSQL 生产双写。

离线迁移与审计：

```bash
# 预检，不写目标库
npm run migrate:postgres -- data/lingjing.db --dry-run --require-empty-target --manifest=migration-dry-run.json
# 正式迁移
npm run migrate:postgres -- data/lingjing.db --require-empty-target --manifest=migration-final.json
# PostgreSQL + Local/S3/MinIO 对象快速审计
npm run audit:postgres-objects
# 维护窗口内流式 SHA-256 全量审计
npm run audit:postgres-objects -- --full-checksum
```

`--manifest` 不覆盖已有文件；对象缺失、大小或校验和不匹配时审计命令返回退出码 2。

该拓扑在默认 `DATABASE_DRIVER=sqlite` 时使用 SQLite 保存权威业务元数据；切换后由 PostgreSQL 保存业务元数据，MinIO 只保存媒体对象；`minio-init` 创建私有 Bucket，API 通过内部网络使用 path-style S3。MinIO Console 不发布到宿主机。PostgreSQL/Redis 拓扑仍属于下一阶段。

停止服务：

```bash
docker compose down
```

验收命令：

```bash
npm run check                 # lint + 双 TypeScript + 718 个 Vitest
npm run build                 # Server + Admin production build
npm run test:browser          # SQLite 8 项 + PostgreSQL 7 项 Browser acceptance
npm run test:minio            # 已启动 S3-compatible endpoint 时运行真实 MinIO adapter test
```

PostgreSQL Browser 命令会自动启动并清理隔离 PostgreSQL 容器，等待 `/healthz` 后再运行 Playwright。

## 管理控制台、预算与账号登录

设置非空 `LINGJING_ADMIN_PASSWORD` 后，访问 `http://127.0.0.1:8000/admin/`。管理员密码只创建管理会话，不能调用生成 API；`LINGJING_API_KEY` 只保护兼容 API，也不能登录管理控制台。管理员登录使用 `HttpOnly`、`SameSite=Strict` Cookie，修改操作还要求同源 CSRF；进程重启后需要重新登录。

控制台可以通过 Cookie 导入新增账号，也可以编辑、检查、启用和禁用账号。禁用只阻止新任务，不中断已经提交的任务；删除、角色、导出和告警不在当前 MVP。Cookie 导入成功后账号已完成验证并启用；导入失败不会保留可调度账号。状态为 `needs_login` 的既有账号按 [故障排查](docs/troubleshooting.md) 处理。

服务启动时会立即检查一次签到，之后每个整点对所有已启用且会话健康的账号继续检查，避免因服务重启错过当天签到。每个账号先读取当天签到状态：已签到则跳过，未签到才提交当前活动编号，并在提交后再次读取状态确认。提交前会持久化“账号 + 活动 + 北京日期”闸门；即使验证结果不确定、服务重启或 PostgreSQL 切换实例，当天也不会重复提交。单账号失败不会阻塞其他账号，结果写入安全运行日志且不包含 Cookie、CSRF 或账号名称。账号页面会展示自动签到是否运行、最近与下次检查时间，以及各账号的签到结果。PostgreSQL 多实例使用数据库 advisory lock，确保同一时刻只有一个实例执行整轮签到。

### 从网页账号到托管 API Key

这是受信任本机操作者的手工流程，Cookie 只粘贴到本机 `/admin/`，不应写入终端历史、截图、聊天或 Git：

1. 打开 `<origin>/admin/`，用 `LINGJING_ADMIN_PASSWORD` 登录，再进入“灵境”账号页。
2. 在灵境网页完成登录。在浏览器开发者工具的一个已认证请求中手工复制 `Cookie` Header，或从浏览器导出 Cookie JSON；选择相应格式粘贴到控制台并填写账号名称/预算。网页控制台**不能**自动读取跨域 Cookie，也不能读取带 `HttpOnly` 属性的 Cookie，这是浏览器的同源与 Cookie 安全边界。
3. 提交导入并等待控制台验证；成功响应表示账号已经启用，可确认显示的会员和余额摘要。导入响应和账号列表不会回显 Cookie。
4. 在“Users & projects”创建下游调用主体，在“Plans”分配视频能力、日/月点数与并发限制，再进入“API keys”为指定 Project 创建最小权限 Key。明文 Key 与 Webhook Secret 只在成功创建或轮换时显示一次。
5. 使用控制台显示的 Base URL（通常为 `<origin>/v1`）和 `Authorization: Bearer ${LINGJING_API_KEY}` 调用。这里的 `${LINGJING_API_KEY}` 是调用方环境变量；迁移后应赋值为刚创建的托管 Key，而不是把 Key 写进代码。
6. 怀疑泄露时先禁用 Key 验证调用会得到 401；确认不再需要时撤销。禁用可以重新启用，撤销是终态，不能重新启用或恢复同一明文值。

现有 `.env` 中的共享 `LINGJING_API_KEY` 作为 legacy 环境 Key 仍会被接受，避免现有客户端立刻中断；控制台不会显示它。逐个将客户端改为独立托管 Key，确认后再按本机密钥轮换流程替换 legacy 值。服务启动仍要求一个长度合规的 `LINGJING_API_KEY`，因此不要把它留空。

每日和每月预算按模型元数据中可信的 quoted points（报价点数）记账，而不是按余额差推算：

- `0` 表示 unlimited（不限额），不是“禁止生成”；
- 日/月窗口使用 `Asia/Shanghai` 日历边界，分别在上海时间每日 00:00 和每月 1 日 00:00 重置；
- 新任务先预留完整报价；幂等重放复用同一预留；
- 可证明在上游提交前失败时释放预留；一旦提交可能发生，就计为 charged 且不退款；
- `unknown` 保留预留/计费状态，直到任务终态或管理员明确裁决。

SQLite 中持久保存账号配置、quoted usage、任务账号绑定和预算条目；重启不会清零。备份与恢复必须同时覆盖 SQLite 和 `data/auth`、`data/accounts` 会话目录，见 [安全说明](docs/security.md) 与 [故障排查](docs/troubleshooting.md)。

## 鉴权与公共路由

除 `/healthz`、`/ping` 和独立认证的 `/admin/` 外，兼容 API 路由都要求一个 Bearer Key：控制台创建的启用托管 Key，或过渡期间仍受支持的 legacy `LINGJING_API_KEY`。

```text
Authorization: Bearer $LINGJING_API_KEY
```

| 方法 | 路由 | 用途 |
|---|---|---|
| GET | `/healthz` | 数据库、恢复状态与队列健康 |
| GET | `/ping` | 简单存活检查 |
| GET | `/v1/session` | 会话是否包含 CSRF，不验证余额 |
| GET | `/v1/account` | 脱敏账号、会员和余额摘要 |
| POST | `/token/check` | 兼容入口；空 JSON，返回 `valid` |
| POST | `/token/points` | 兼容入口；空 JSON，返回点数摘要 |
| GET | `/v1/models?type=image` | 图片模型目录 |
| GET | `/v1/models?type=video&mode=text-to-video` | 视频模型目录 |
| POST | `/v1/images/generations` | 图片生成，JSON 或 multipart |
| POST | `/v1/videos` | canonical 异步文生/图生视频，默认 202 |
| GET | `/v1/videos/:id` | 当前 Project 的单个视频任务 |
| GET | `/v1/videos?limit=20&before=...` | 当前 Project 的视频任务列表 |
| POST | `/v1/videos/:id/cancel` | 仅在上游提交前取消 |
| GET | `/v1/tasks/:id` | 单任务状态 |
| GET | `/v1/tasks?limit=20&status=unknown` | 最近任务列表 |
| POST | `/v1/chat/completions` | OpenAI 风格非流式或 SSE 生成 |

`/v1/videos/generations` 仅作为兼容别名，默认等待结果；新调用应使用默认异步的 canonical `/v1/videos`。管理端还提供 Subscriptions、Users & projects、Plans、Usage、Webhooks、API keys 和 Playground 页面。

以下示例假设 shell 已设置 `LINGJING_API_KEY`，不会在命令中写死密钥。

### 账号与模型

```bash
curl -sS http://127.0.0.1:8000/v1/account \
  -H "Authorization: Bearer $LINGJING_API_KEY"

curl -sS "http://127.0.0.1:8000/v1/models?type=image&refresh=true" \
  -H "Authorization: Bearer $LINGJING_API_KEY"
```

优先使用 `/v1/models` 返回的稳定公开 `id`，并按 `parameters`、`capabilities` 和 `pricing` 构造请求。模型目录是网页端快照，提交前会再刷新；变化会返回 `model_catalog_changed`。

### 图片：JSON

`input_images` 支持公网 `http/https` URL 或 `data:` URI；`response_mode` 为 `wait` 或 `async`，`response_format` 为 `url` 或 `b64_json`。

```bash
curl -sS http://127.0.0.1:8000/v1/images/generations \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: image-demo-0001" \
  -d '{
    "model": "MODEL_ID_FROM_V1_MODELS",
    "prompt": "雨后的山谷，柔和晨光",
    "n": 1,
    "size": "1024x1024",
    "response_format": "url",
    "response_mode": "wait"
  }'
```

### 图片：multipart/form-data

文本字段为 `model`、`prompt`、`n`、`size`、`response_format`、`response_mode`、`parameters`；文件字段可用 `image`、重复的 `input_images` 或 `input_images[]`，最多 14 张。`parameters` 与文本形式的 `input_images` 使用 JSON 字符串。OpenAPI 同时公开这些 multipart schema/fields。

```bash
curl -sS http://127.0.0.1:8000/v1/images/generations \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Idempotency-Key: image-multipart-0001" \
  -F "model=MODEL_ID_FROM_V1_MODELS" \
  -F "prompt=保持人物特征，改为电影光影" \
  -F "response_mode=wait" \
  -F "image=@./input.png;type=image/png"
```

### 文生视频

```bash
curl -sS http://127.0.0.1:8000/v1/videos \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: t2v-demo-0001" \
  -d '{
    "model": "TEXT_TO_VIDEO_MODEL_ID",
    "prompt": "固定机位，云海缓慢流动",
    "mode": "text-to-video",
    "duration": 5,
    "resolution": "720p",
    "ratio": "16:9",
    "response_mode": "async"
  }'
```

### 图生视频

```bash
curl -sS http://127.0.0.1:8000/v1/videos \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Idempotency-Key: i2v-demo-0001" \
  -F "model=IMAGE_TO_VIDEO_MODEL_ID" \
  -F "prompt=镜头缓慢推进，主体自然眨眼" \
  -F "mode=image-to-video" \
  -F "duration=5" \
  -F "response_mode=async" \
  -F "input_images[]=@./first-frame.png;type=image/png"
```

### 异步任务

`POST /v1/videos` 默认异步并立即返回 HTTP 202、`Location: /v1/videos/<id>` 和任务对象；`/v1/videos/generations` 才是默认等待的兼容入口。等待模式超时但任务仍在运行时也返回 202。

```bash
curl -sS http://127.0.0.1:8000/v1/videos/JOB_ID \
  -H "Authorization: Bearer $LINGJING_API_KEY"

# 兼容任务查询同样可用
curl -sS http://127.0.0.1:8000/v1/tasks/JOB_ID \
  -H "Authorization: Bearer $LINGJING_API_KEY"
```

状态为 `queued`、`submitting`、`discovering`、`processing`、`unknown`、`completed` 或 `failed`；输出只在可确认并归档后出现。返回的 `/v1/assets/<id>` 需要相同 Project API Key，可用 HTTP Range 播放或下载。

### Chat Completions 与 SSE

Chat 输入接受字符串内容，或 OpenAI 风格 `text` / `image_url` 内容块。返回内容是生成图片的 Markdown image 或视频链接；usage 固定为 0，不代表上游免费。

```bash
curl -sS http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: chat-demo-0001" \
  -d '{
    "model": "MODEL_ID_FROM_V1_MODELS",
    "messages": [{"role": "user", "content": "生成一张极简海报"}],
    "stream": false
  }'
```

SSE：

```bash
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $LINGJING_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: chat-sse-0001" \
  -d '{
    "model": "MODEL_ID_FROM_V1_MODELS",
    "messages": [{"role": "user", "content": "生成一段日落延时视频"}],
    "stream": true
  }'
```

响应类型是 `text/event-stream`：先发送 assistant role chunk；运行较久时发送 `event: progress`；完成后发送内容、stop chunk 与 `data: [DONE]`。流建立后的错误使用 `event: error`，HTTP 状态仍可能已经是 200。

## 错误格式与 HTTP 映射

所有普通错误使用：

```json
{
  "error": {
    "message": "Lingjing upstream request failed",
    "type": "upstream_error",
    "param": null,
    "code": "lingjing_upstream_error"
  }
}
```

| HTTP | 典型 code | 含义 |
|---:|---|---|
| 400 | `invalid_request`, `unsafe_media_url`, `content_policy_violation` | 参数、媒体地址或内容不合法 |
| 401 | `invalid_api_key` | 下游 Bearer 密钥无效 |
| 403 | `lingjing_permission_denied` | 上游账号无权限 |
| 404 | `task_not_found`, `route_not_found` | 本地任务或路由不存在 |
| 409 | `model_catalog_changed`, `idempotency_conflict` | 模型目录变化或幂等键冲突 |
| 413 | `request_too_large` | JSON、multipart 或媒体超限 |
| 429 | `lingjing_insufficient_points`, `lingjing_rate_limited` | 点数不足或限流 |
| 502 | `lingjing_upstream_error`, `lingjing_submit_ambiguous` | 上游响应不可验证 |
| 503 | `lingjing_session_expired`, `lingjing_csrf_expired`, `temporary_storage_exhausted` | 需刷新会话或本地容量不足 |
| 504 | `generation_timeout` | Chat 等待超时 |

## Exactly-once 边界与 `unknown`

`Idempotency-Key` 在本地 SQLite 中绑定规范化请求：同键同输入复用原任务，同键不同输入返回 409。真正的上游生成提交只执行一次，**不会自动重放生成请求**。读取目录、资产和任务状态可以有限重试，但带计费风险的提交不会重试。

若连接在提交后、确认前断开，系统无法证明上游是否已扣费或创建任务。它会通过提交前资产基线、时间、场景、模型和请求指纹发现资产；无法唯一确认时持久化为 `unknown`，在保留窗口内继续恢复并占用并发槽。不要因为 502、超时或 `unknown` 立即换新幂等键重提；先查询 `/v1/tasks/:id`、网页资产和点数记录。超出恢复窗口仍不能确认时，需要人工裁决。

## 成本与实时测试

`tests/unit`、`tests/contract`、`tests/integration` 以及 Docker smoke 全部使用假 fixture，不应访问京东云。`docker-compose.test.yml` 使用 internal 网络，明确阻断外网。

`tests/live` 是显式开启的真实账号验收。默认运行 `npm run test:live` 时四个 live 套件全部 skip，不创建运行时、不读取认证内容，也不访问京东云；不要在普通 CI 中设置 live 标志。

真实验收前必须先由用户运行 `npm run login`，并确保本地忽略的 `data/auth/storage-state.json` 与 `data/auth/session-profile.json` 有效。测试只通过现有 SessionProvider 读取这些文件，不会打印 Cookie、账号标识或认证文件内容。成功媒体会下载到已忽略的 `outputs/`，并验证 Content-Type、字节上限和 PNG/JPEG/WebP/GIF 或 MP4/WebM 文件签名。

Windows PowerShell 的执行顺序：

```powershell
$env:LIVE_TEST = "1"
npm run test:live -- --run tests/live/session.live.test.ts tests/live/account-models.live.test.ts
npm run test:live -- --run tests/live/image.live.test.ts

$env:LIVE_VIDEO_TEST = "1"
npm run test:live:video

Remove-Item Env:LIVE_VIDEO_TEST
Remove-Item Env:LIVE_TEST
```

运行前必须先通过 `npm run login` 或管理控制台 Cookie 导入建立 `data/auth` / `data/accounts` 下的有效 Session；若 Session 文件缺失，或 Live Flags 未显式设置，不得声称完成真实 T2V/I2V E2E。

图片测试只有在 `LIVE_TEST=1` 时运行；视频还必须同时满足 `LIVE_VIDEO_TEST=1`。每次生成前都会重新读取余额、当前模型元数据和报价，动态构造模型必填参数；若没有可确认报价、参数不兼容或余额不足，会在提交前安全失败，不会改用其他收费系统。图片和视频测试各自包装真实 transport，并断言计费提交 `submitOnce` 恰好发生一次；完成后还会确认任务绑定到 `legacy`，且 quoted usage 可从管理 API 读取。

live 输出仅允许模型 display name、带引号的预计点数、本地 job ID、脱敏状态和数字余额变化。Prompt、生成 URL、上游 task ID、账号身份和 Cookie 都不会写入输出或验收记录。媒体下载使用固定 DNS、逐跳重定向检查和字节上限，文件仅写入已忽略的 `outputs/`。

### 真实验收记录

仅在对应真实流程完整成功后添加一行；不得根据 mock、历史页面操作或部分运行填写。数字余额变化来自完成前后的同一账号快照；`0` 只表示该窗口内未观察到点数变化，可能来自订阅权益或延迟结算，不能据此假定其他账号或模型免费。

以下表格是本次多账号管理后台改造前保留的历史成功记录：

| 日期 | 能力 | 模型 display name | 脱敏状态 | 数字余额变化 |
|---|---|---|---|---:|
| 2026-07-24 | 图片生成 | Seedream 5.0 Lite | completed | 0 |
| 2026-07-24 | 文本转视频 | HappyHorse-1.1 | completed | 0 |

本次 Task 6 的真实验收结果与历史记录分开：Seedream 5.0 Lite 图片生成已完成并下载为有效 JPEG；HappyHorse 与 Seedance 两个视频模型族均在上游提交阶段返回 `generation_submit_rejected`，没有视频媒体，因此本次视频端到端验收**未完成**。每次受控尝试都使用新幂等键并验证 `submitOnce` 恰好一次，项目没有自动重试；遇到两个模型族同类拒绝后已停止继续消耗。

## 安全、隐私与运维

- 只绑定 loopback，不直接暴露公网；确需反向代理时，由代理完成 TLS、访问控制和请求大小限制。
- 灵境 Cookie、下游 `LINGJING_API_KEY` 与 `LINGJING_ADMIN_PASSWORD` 三者完全分离，禁止复用、提交到 Git 或内联写入 Compose。
- Prompt、上传媒体、生成结果 URL、账号余额和 SQLite 均可能是敏感数据；按本机秘密处理。
- 日志会脱敏凭据、查询串、Prompt 和媒体，但仍不要把 debug 日志随意外发。
- 远程媒体只允许公网 HTTP(S)，解析地址会固定并拦截本机、私网、保留地址和危险重定向。
- `/app/data` 是容器唯一持久化凭据/数据库挂载；定期备份并限制宿主机权限。
- 下游任务、资产、用量与幂等键按 Project/API Key 隔离；Plan 可限制视频模式、模型、时长、分辨率、点数、并发和排队。管理平面仍是单管理员密码，没有 RBAC、支付和多管理员协作。

完整说明：

- [协议与可变的网页端细节](docs/protocol.md)
- [安全模型与凭据轮换](docs/security.md)
- [故障排查与安全命令](docs/troubleshooting.md)
- [内部发布就绪清单](docs/release-readiness.md)
