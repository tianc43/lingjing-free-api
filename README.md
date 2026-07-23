# Lingjing Free API

把已登录的灵境网页会话封装为一个本机、单用户的 OpenAI 风格 HTTP 适配器，提供图片生成、视频生成、任务查询和 Chat Completions 兼容入口。

## 项目边界

本项目调用的是灵境网页端接口，不是京东云官方开放 API，也不代表官方支持的集成方式。**订阅不等于官方 API**：网页会员、点数或套餐只说明账号可在网页产品中使用相应能力，不会自动获得稳定的 API 合约、SLA、商用授权或免额外计费。网页接口、字段、模型目录和风控规则可能随时变化，详见 [docs/protocol.md](docs/protocol.md)。

请遵守服务条款、内容规范和所在地法律。每次生成都可能消耗真实点数；本项目不会绕过计费、权限或内容审核。版本一只面向可信机器上的**单用户**运行，不是多租户网关。

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

`npm run login` 会从 `.env` 读取路径，打开本机 Chromium。完成灵境登录后，它原子写入：

- `data/auth/storage-state.json`：Playwright Cookie 状态；
- `data/auth/session-profile.json`：账号定位所需的最小配置。

浏览器登录只能在本机运行，版本一 Docker 镜像内不包含登录 GUI。会话过期、CSRF 失效或切换账号时，在停止写入竞争后重新执行 `npm run login`；服务会在下次加载时采用新文件。

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

生产 Compose 只发布 `127.0.0.1:8000`，只把 `./data` 挂载到 `/app/data`，容器以非 root `node` 用户运行，并启用 `cap_drop: ALL` 与 `no-new-privileges`。不要把 `docker-compose.test.yml` 用于生产；它只有全假凭据、隔离网络和可删除的 smoke 数据卷。

停止服务：

```bash
docker compose down
```

## 鉴权与公共路由

除 `/healthz` 和 `/ping` 外，所有路由都要求：

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
| POST | `/v1/videos/generations` | 文生视频或图生视频 |
| GET | `/v1/tasks/:id` | 单任务状态 |
| GET | `/v1/tasks?limit=20&status=unknown` | 最近任务列表 |
| POST | `/v1/chat/completions` | OpenAI 风格非流式或 SSE 生成 |

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
curl -sS http://127.0.0.1:8000/v1/videos/generations \
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
    "response_mode": "wait"
  }'
```

### 图生视频

```bash
curl -sS http://127.0.0.1:8000/v1/videos/generations \
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

`response_mode=async` 立即返回 HTTP 202、`Location: /v1/tasks/<id>` 和任务对象。等待模式超时但任务仍在运行时也返回 202。

```bash
curl -sS http://127.0.0.1:8000/v1/tasks/JOB_ID \
  -H "Authorization: Bearer $LINGJING_API_KEY"
```

状态为 `queued`、`submitting`、`discovering`、`processing`、`unknown`、`completed` 或 `failed`；输出只在可确认后出现。

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

真实验收前必须先由用户运行 `npm run login`，并确保本地忽略的 `data/auth/storage-state.json` 与 `data/auth/session-profile.json` 有效。测试只通过现有 SessionProvider 读取这些文件，不会打印 Cookie、账号标识或认证文件内容。

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

图片测试只有在 `LIVE_TEST=1` 时运行；视频还必须同时满足 `LIVE_VIDEO_TEST=1`。每次生成前都会重新读取余额、当前模型元数据和报价，动态构造模型必填参数；若没有可确认报价、参数不兼容或余额不足，会在提交前安全失败，不会改用其他收费系统。图片和视频测试各自包装真实 transport，并断言计费提交 `submitOnce` 恰好发生一次。

live 输出仅允许模型 display name、带引号的预计点数、本地 job ID、脱敏状态和数字余额变化。Prompt、生成 URL、上游 task ID、账号身份和 Cookie 都不会写入输出或验收记录。生成 URL 只做 HEAD 或最多 64 KiB 的 bounded GET 可达性验证。

### 真实验收记录

仅在对应真实流程完整成功后添加一行；不得根据 mock、历史页面操作或部分运行填写。数字余额变化来自完成前后的同一账号快照；`0` 只表示该窗口内未观察到点数变化，可能来自订阅权益或延迟结算，不能据此假定其他账号或模型免费。

| 日期 | 能力 | 模型 display name | 脱敏状态 | 数字余额变化 |
|---|---|---|---|---:|
| 2026-07-24 | 图片生成 | Seedream 5.0 Lite | completed | 0 |
| 2026-07-24 | 文本转视频 | HappyHorse-1.1 | completed | 0 |

## 安全、隐私与运维

- 只绑定 loopback，不直接暴露公网；确需反向代理时，由代理完成 TLS、访问控制和请求大小限制。
- 灵境 Cookie 与下游 `LINGJING_API_KEY` 完全分离，禁止复用、提交到 Git 或写入 Compose。
- Prompt、上传媒体、生成结果 URL、账号余额和 SQLite 均可能是敏感数据；按本机秘密处理。
- 日志会脱敏凭据、查询串、Prompt 和媒体，但仍不要把 debug 日志随意外发。
- 远程媒体只允许公网 HTTP(S)，解析地址会固定并拦截本机、私网、保留地址和危险重定向。
- `/app/data` 是容器唯一持久化凭据/数据库挂载；定期备份并限制宿主机权限。
- 本项目没有用户隔离、租户配额、审计授权或共享会话隔离，只适合单用户。

完整说明：

- [协议与可变的网页端细节](docs/protocol.md)
- [安全模型与凭据轮换](docs/security.md)
- [故障排查与安全命令](docs/troubleshooting.md)
