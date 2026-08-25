# Lingjing 视频订阅转 API 技术方案

> 状态：架构设计草案
> 目标：参考 Sub2API 的“订阅池、下游 Key、配额、调度、计费、可观测性”思想，将一个或多个灵境网页订阅转换为可管理的文生视频和图生视频 API。灵境仍是唯一上游 Provider；不照搬 Sub2API 的多模型聊天网关复杂度。

## 1. 产品边界

### 1.1 核心目标

1. 管理多个灵境订阅账号及其 Cookie 会话、会员状态、点数、模型能力和健康状态。
2. 向下游用户签发 API Key，并按用户、Key、套餐和模型限制调用。
3. 提供统一、稳定的异步视频 API：文生视频、图生视频、任务查询与可选 Webhook。
4. 在上游网页协议不稳定、提交结果不确定时保证不自动重复扣费。
5. 记录每次请求的调用主体、账号路由、预估成本、最终状态和计费流水。
6. 通过 Web 控制台完成账号、用户、Key、套餐、任务、用量和系统配置管理，并可发起受控测试调用。

### 1.2 首期不做

- 支付、充值、发票、推广码和复杂营销体系。
- 多 Provider 聚合、聊天模型转发和任意协议转换。
- 自动绕过灵境的风控、计费、权限或内容审核。
- 在无法证明上游未创建任务时自动换账号重试。
- 将灵境订阅描述为官方 API、SLA 或商用授权。

## 2. 从 Sub2API 借鉴什么

| Sub2API 思路 | 本项目采用方式 | 首期取舍 |
| --- | --- | --- |
| 上游账号池 | 灵境 Subscription Account Pool | 采用 |
| 用户、API Key、分组/套餐 | User + API Key + Plan | 采用简化版 |
| 智能调度、并发控制、冷却 | 按模型能力、健康、余额、并发和冷却筛选 | 采用 |
| 精确用量日志和计费 | 视频按模型、分辨率、时长记录 quote/settlement | 采用 |
| 请求限速和配额 | Key/User 级 RPM、并发、日/月额度 | 采用 |
| 多 Provider、复合分组 | 仅保留 Provider 接口，首期只有 Lingjing | 不实现多 Provider UI |
| 支付和充值 | 预留 Ledger 接口 | 首期不做 |
| PostgreSQL + Redis | 生产目标采用；本机开发可使用 SQLite 单进程模式 | 分级部署 |
| Sticky session | 视频任务创建后固定绑定上游账号 | 必须采用 |

## 3. 总体架构

采用“模块化单体 + 独立 Worker”的结构，先保持 TypeScript/Fastify/React 技术栈，避免无价值的语言重写。

```text
                           ┌────────────────────┐
                           │ React Admin Console │
                           └─────────┬──────────┘
                                     │ Admin Session + CSRF
┌──────────────┐  Bearer Key  ┌──────▼────────────────────────────┐
│ API Clients  ├──────────────► API / Control Plane (Fastify)     │
└──────────────┘               │ Auth · Plans · Quota · Jobs      │
                               └──────┬──────────────┬─────────────┘
                                      │ PostgreSQL   │ Redis queue/leases
                               ┌──────▼──────┐ ┌────▼──────────────┐
                               │ Metadata DB │ │ Video Worker Pool │
                               └─────────────┘ └────┬──────────────┘
                                                    │
                               ┌────────────────────▼──────────────┐
                               │ Lingjing Provider Adapter         │
                               │ Session · Catalog · Upload        │
                               │ SubmitOnce · Discover · Poll      │
                               └───────────────┬───────────────────┘
                                               │
                                      lingjing.jdcloud.com

                   Input/output media ──► S3-compatible Object Storage
```

### 3.1 模块职责

- **Identity & Access**：用户、管理员、API Key、Scope、密钥轮换。
- **Plans & Policy**：允许的能力/模型、RPM、并发、日/月额度、最大时长和分辨率。
- **Subscription Pool**：上游账号、会话凭据、会员、点数、健康、冷却和能力快照。
- **Video Jobs**：任务状态机、幂等、输入资产、结果、Webhook。
- **Scheduler**：候选过滤、评分、原子绑定和容量租约。
- **Usage Ledger**：预留、扣费、释放、调整和聚合。
- **Provider Adapter**：隔离所有灵境网页协议细节。
- **Operations**：审计日志、指标、告警、配置和数据保留。

## 4. 核心领域模型

### 4.1 下游身份

#### `users`

- `id`, `name`, `status`
- `plan_id`
- `daily_limit_points`, `monthly_limit_points`（可覆盖套餐）
- `max_concurrency`, `rpm_limit`
- `created_at`, `updated_at`

#### `api_keys`

- `id`, `user_id`, `name`
- `prefix`, `secret_hash`
- `scopes`: `video:create`, `video:read`, `models:read`
- `allowed_model_aliases`
- `expires_at`, `last_used_at`, `enabled`, `revoked_at`

认证中间件必须返回 `RequestPrincipal { userId, apiKeyId, planId, scopes }`，不能继续只返回 boolean。所有任务和流水必须绑定调用主体。

### 4.2 套餐与路由组

#### `plans`

- `name`, `enabled`
- `allowed_modes`: `text-to-video`, `image-to-video`
- `allowed_models`
- `max_duration_seconds`, `allowed_resolutions`
- `rpm_limit`, `max_concurrency`
- `daily_limit_points`, `monthly_limit_points`
- `billing_multiplier`

首期不需要 Sub2API 那样复杂的多 Provider Group；Plan 同时承担访问策略和定价策略。未来若要将不同账号池隔离，再增加 `account_pools`，不要让 Plan 直接保存账号 ID 列表。

### 4.3 上游订阅账号

#### `subscription_accounts`

- `id`, `provider = lingjing`, `name`
- `enabled`, `schedulable`, `priority`, `weight`
- `health_status`, `health_reason`
- `membership`, `subscription_expires_at`
- `points_balance`, `total_balance`, `balance_checked_at`
- `max_concurrency`, `active_leases`
- `rate_limit_reset_at`, `cooldown_until`
- `last_selected_at`, `last_success_at`, `consecutive_failures`
- `credential_ref`（指向加密凭据，不存原始 Cookie）

#### `account_capabilities`

按账号保存模型目录快照：

- `account_id`, `public_model_alias`, `source_type`
- `upstream_api_id`, `catalog_revision`
- `parameter_schema`, `pricing_snapshot`
- `upload_strategy`, `enabled`, `refreshed_at`

公开模型别名与上游 `apiId/refId/modelCode` 必须分离，避免网页目录变化直接破坏下游 API。

### 4.4 视频任务

#### `video_jobs`

- 归属：`user_id`, `api_key_id`, `plan_id`, `account_id`
- 请求：`mode`, `requested_model`, `resolved_model`, `prompt_hash`
- 参数：`duration`, `resolution`, `ratio`, `parameter_snapshot`
- 幂等：`idempotency_key_hash`, `request_fingerprint`
- 上游：`upstream_task_id`, `upstream_fingerprint`, `catalog_revision`
- 状态：见 6.1
- 计费：`quoted_points`, `settled_points`, `ledger_state`
- 时间：创建、入队、提交、发现、完成、失败时间
- 错误：公开错误码、内部诊断码

Prompt 默认不进入普通日志；数据库是否保存原文由数据保留配置决定，默认只保存 hash 和可选加密快照。

#### `job_assets`

- `job_id`, `role = input|output|poster`
- `storage_key`, `sha256`, `mime_type`, `size_bytes`
- `width`, `height`, `duration`, `expires_at`

图生视频的输入图必须先持久化到对象存储，再把任务放入队列。当前只依赖临时文件和进程内 Runner 的做法不能支撑 Worker 重启和横向扩展。

### 4.5 用量流水

#### `usage_ledger`

追加写，不做原地覆盖：

- `id`, `job_id`, `user_id`, `api_key_id`, `account_id`
- `type = reserve|charge|release|adjust`
- `points`, `reason`, `created_at`

同时保留两个视角：

1. **上游成本**：灵境 quote/实际可确认消耗。
2. **下游计量**：套餐倍率后的计费单位。

首期即使不收款，也必须分开，才能回答“哪个用户消耗了哪个订阅账号的多少视频额度”。

## 5. 对外 API 设计

### 5.1 模型目录

```http
GET /v1/models?type=video&mode=text-to-video
GET /v1/models?type=video&mode=image-to-video
Authorization: Bearer fixture-api-key
```

返回稳定公开模型、支持的时长/分辨率/比例、是否要求输入图及预计点数。返回集合是“调用者 Plan 允许”与“当前账号池至少一个账号支持”的交集。

### 5.2 创建视频任务

Canonical 接口：

```http
POST /v1/videos
Authorization: Bearer fixture-api-key
Idempotency-Key: <8..200 chars>
Content-Type: application/json | multipart/form-data
```

文生视频：

```json
{
  "model": "lingjing-video-standard",
  "mode": "text-to-video",
  "prompt": "固定机位，云海缓慢流动",
  "duration": 5,
  "resolution": "720p",
  "ratio": "16:9"
}
```

图生视频允许 multipart 文件，或先通过安全上传接口获得 `input_asset_id`。生产方案优先使用预签名直传，避免大图长期穿过 API 进程。

创建成功统一返回 `202`：

```json
{
  "id": "vidjob_xxx",
  "object": "video.job",
  "status": "queued",
  "mode": "text-to-video",
  "model": "lingjing-video-standard",
  "quoted_points": 20,
  "created_at": 1730000000,
  "status_url": "/v1/videos/vidjob_xxx"
}
```

视频天然是长任务，首期不建议默认 HTTP 长等待。可保留 `response_mode=wait` 作为兼容层，但 canonical 行为应为异步 202。

### 5.3 查询、取消与 Webhook

```http
GET  /v1/videos/:id
GET  /v1/videos?status=processing&limit=20&cursor=...
POST /v1/videos/:id/cancel
```

取消只在“尚未上游提交”时保证成功；提交后只能标记 `cancel_requested`，不能声称已停止扣费。

可选 Webhook：

- 事件：`video.completed`, `video.failed`, `video.unknown`
- HMAC-SHA256 签名、时间戳、事件 ID
- 至少一次投递，消费者按事件 ID 去重
- 重试不触发上游任务重试

### 5.4 资源归属

普通 API Key 只能查询自己所属 User 的任务。管理员可跨用户查询。必须修复当前“任意有效 Key 可读取全局任务”的模型。

## 6. 视频任务状态机与 Exactly-once

### 6.1 状态机

```text
accepted → queued → preparing_input → reserved → submitting
                                      │            │
                                      │            ├─ proven rejected → failed + release
                                      │            └─ ambiguous → discovering/unknown + charge
                                      ▼
                                discovering → processing → completed
                                      │             │
                                      └───────→ unknown
                                                    │
                                          admin reconciliation
```

公开状态可压缩为 `queued`, `processing`, `completed`, `failed`, `unknown`；内部状态保留细粒度，便于恢复和审计。

### 6.2 不可破坏的规则

1. `Idempotency-Key` 的唯一域是 `api_key_id + key`，而不是全系统共享。
2. 同 Key 同规范化请求返回原任务；同 Key 不同请求返回 409。
3. 上游收费提交 `submitOnce` 永不自动重放。
4. 提交前失败释放预留；提交可能发生后转为 charge。
5. 无法确认上游 taskId 时通过持久化的资产基线发现；无法唯一确认进入对账流程。
6. 任务一旦绑定账号，恢复、发现和轮询始终使用原账号。
7. 不确定任务只能继续发现或由管理员裁决，不能静默重提。
8. 只有明确无收费副作用的目录读取、资产读取、已知任务轮询、输出下载和 Webhook 投递可以有界重试。
9. 网络超时、连接中断、5xx 或畸形响应只要发生在 `submitOnce` 调用期间，均视为可能已经提交；不得在同账号或其他账号重试。
10. 自动换账号只能发生在进入 `submitting` 之前，或已经通过真实协议证明上游明确未创建任务时。

当前项目的提交前资产基线、唯一候选发现、`unknown` 和预算保留逻辑应保留，这是视频网关最有价值的正确性基础。但资产基线必须在提交前持久化，不能继续只存在于 Worker 内存中。

### 6.3 Provider Submission 与关联证据

视频 Job 和上游提交必须拆开建模。`provider_submissions` 保存一次不可重复的提交意图：

- `job_id`, `provider`, `account_id`, `attempt_number`
- `submit_token`, `request_fingerprint`, `upstream_fingerprint`
- `catalog_revision`, `baseline_snapshot_ref`, `baseline_captured_at`
- `submit_started_at`, `submit_finished_at`, `outcome`, `ambiguity_reason`

`provider_correlations` 保存任务关联证据：

- `job_id`, `submission_id`, `account_id`
- `upstream_task_id`, `upstream_asset_id`, `creation_code`
- `evidence_type`, `confidence`, `correlated_at`, `conflict_reason`

经过真实协议确认字段稳定性后，对 `(provider, account_id, upstream_task_id)`、asset identity 和 creation code 建立部分唯一约束。绑定冲突进入 reconciliation，禁止覆盖或猜测。

### 6.4 内部不确定状态

内部不得再用单个 `unknown` 同时表达提交、关联、上游状态和账务不确定：

- `submission_ambiguous`
- `correlation_ambiguous`
- `provider_status_unknown`
- `reconciliation_required`

外部 API 可以统一展示 `status=unknown`，但必须同时返回安全的 `reason`。容量、轮询、账务和人工处理根据内部原因分别执行。

## 7. 调度策略

### 7.1 候选硬过滤

按顺序过滤：

1. 账号 enabled + schedulable。
2. 会话健康且会员未过期。
3. 账号目录支持请求模型、模式和参数。
4. 不在 rate-limit/cooldown 窗口。
5. 有并发槽位和队列容量。
6. 钱包余额、账号日/月安全预算足够覆盖 quote。
7. 账号允许当前 Plan/account pool。

### 7.2 评分

```text
score = priority_weight
      + active_concurrency_ratio * 40
      + recent_failure_penalty
      + cooldown_penalty
      + estimated_cost_penalty
      + least_recently_used_tiebreaker
```

首期采用可解释的排序：`priority → active ratio → consecutive failures → last selected → account id`。不要一开始引入不可解释的动态算法。

### 7.3 反馈与熔断

- 401/CSRF 失效：标记 `needs_login`，立即移出候选池。
- 429：写入 `rate_limit_reset_at`；没有明确 reset 时指数冷却并设上限。
- 5xx/超时：累计短期失败；超过阈值临时熔断。
- 内容审核/参数错误：不惩罚账号健康。
- 成功完成：衰减失败计数，更新 last_success/last_selected。

账号自动切换只能发生在上游提交之前。提交后失败不能换账号重新创建视频。

## 8. Provider 边界

将现有灵境协议代码收敛到接口：

```ts
interface VideoProvider {
  validateCredential(candidate: Credential): Promise<AccountSnapshot>;
  listCapabilities(account: ProviderAccount, refresh: boolean): Promise<VideoModel[]>;
  quote(account: ProviderAccount, request: NormalizedVideoRequest): Promise<Quote>;
  uploadInputs(account: ProviderAccount, inputs: StoredAsset[]): Promise<ProviderMaterial[]>;
  submitOnce(account: ProviderAccount, request: ProviderVideoRequest): Promise<SubmitOutcome>;
  discover(account: ProviderAccount, context: DiscoveryContext): Promise<DiscoveryOutcome>;
  poll(account: ProviderAccount, upstreamTaskId: string): Promise<ProviderTask>;
}
```

Lingjing Adapter 内部保留：

- Cookie/CSRF 会话与 Set-Cookie 回写。
- `getBySourceType/getByApiId` 模型目录。
- `uploadMaterials` 和 general signed upload。
- `executeByApiId` 单次提交。
- asset list 唯一候选发现。
- `describeUserTask` 轮询和输出规范化。

领域层不得再出现 `apiId`, `refId`, `sceneCode`, Lingjing URL 或网页信封解析。

## 9. 存储与部署

### 9.1 两种运行模式

#### Local 模式

- SQLite + 本地文件对象存储。
- API 与 Worker 同进程，但仍通过持久任务表领取任务。
- 面向单机自用和开发。

#### Production 模式

- PostgreSQL：权威元数据、任务、Ledger、审计。
- Redis：速率限制、并发租约、任务通知和短期缓存；不作为任务唯一真相。
- S3/MinIO：输入图、可选输出代理缓存。
- API 进程与 Worker 进程可独立扩缩容。

### 9.2 Worker 领取

使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 或带 fencing token 的 lease：

- `worker_id`, `lease_token`, `lease_expires_at`, `heartbeat_at`
- Worker 只能用当前 token 更新任务。
- Lease 过期后仅恢复未提交或安全可恢复阶段。
- `submitting` 阶段恢复只能进入 discovery，不能重新 submit。

## 10. 安全与合规

- 上游 Cookie 使用 envelope encryption；主密钥来自环境变量/KMS，数据库只存密文和版本。
- API Key 只存 hash，明文仅创建时显示一次；认证结果短期缓存并支持主动失效。
- Prompt、输入图、生成结果和 Cookie 均视为敏感数据；配置保留期和删除任务。
- 管理操作写不可变审计日志：操作者、动作、目标、结果、时间、request ID。
- 管理端使用 CSP、`frame-ancestors 'none'`、nosniff、Referrer/Permissions Policy；公网部署必须 TLS。
- 远程输入图继续执行 DNS pin、私网地址拦截、重定向复检和大小/MIME 限制。
- 明确提示网页接口变更、封号、条款、版权、内容审核和无 SLA 风险。

## 11. 管理控制台信息架构

1. **Overview**：可调度账号、今日视频量、成功率、排队时长、点数消耗、异常任务。
2. **Subscriptions**：账号导入、会员/余额、模型能力、健康、并发、冷却、启停、检查。
3. **Users & Plans**：用户状态、套餐、配额、允许模型和有效期。
4. **API Keys**：Key scope、模型白名单、并发/RPM 覆盖、禁用、撤销、最后使用。
5. **Video Jobs**：用户/Key/账号/模式/模型/状态筛选，时间线，输入输出元数据，unknown 裁决。
6. **Playground**：文生视频和图生视频测试、真实价格警告、任务轮询、结果预览。
7. **Usage**：按用户、Key、账号、模型、分辨率和日期聚合 quote/charge/release。
8. **Configuration**：公开 Base URL、Webhook、数据保留、上传限制、冷却策略和只读运行诊断。

## 12. 分阶段实施

### Phase 0：协议基线

- 用隔离账号重新确认文生视频与图生视频的模型目录、必填参数、报价、上传、提交、发现和轮询。
- 为至少一个 T2V 和一个 I2V 模型保存脱敏 fixture。
- 验收：两条真实链路各完成一次，提交次数严格为 1。

### Phase 1：身份归属和异步视频 API

- API Key 认证返回 principal。
- Job 增加 `user_id/api_key_id`，任务查询按归属隔离。
- `/v1/videos` 默认异步 202；增加分页查询。
- 幂等唯一域改为 API Key。
- 验收：两个 Key 互相看不到任务；同 Key 幂等不重复提交。

### Phase 2：持久输入与 Worker

- 引入 `job_assets` 和 S3/本地对象存储抽象。
- 入队前持久化图生视频输入。
- 将进程内 runner 改为 lease-based worker。
- 验收：queued/preparing/processing 各阶段重启均不丢任务、不重复提交。

### Phase 3：Plan、配额和 Ledger

- 用户、Plan、Key scopes、模型白名单、RPM、并发。
- reserve/charge/release 追加流水和聚合。
- 视频按模型/分辨率/时长报价；未知报价按策略拒绝。
- 验收：并发竞态不会超额度，失败和 unknown 的流水正确。

### Phase 4：账号池可靠性

- capability snapshots、冷却、熔断、健康检查、目录漂移监控。
- 调度评分和账号池隔离。
- 验收：提交前故障自动选其他账号；提交后故障绝不重提。

### Phase 5：管理体验和可观测性

- Users/Plans、任务详情、Usage、Webhook、unknown 裁决。
- 指标：成功率、提交失败率、unknown 率、排队时间、生成耗时、账号可用率。
- 告警：所有账号不可用、连续 401/429、unknown 积压、队列/对象存储接近上限。

### Phase 6：生产化

- PostgreSQL/Redis/MinIO 部署、凭据加密、审计、安全头、备份恢复、数据清理。
- 负载、故障注入、升级回滚与灾难恢复演练。

## 13. MVP 完成标准

1. 至少两个下游用户及 Key，任务数据完全隔离。
2. 至少两个灵境订阅账号可进入池并按能力/健康/容量调度。
3. T2V/I2V 都能通过异步 API 创建、查询并返回规范化视频结果。
4. 图生视频输入在 Worker/服务重启后仍可恢复。
5. 同一幂等请求在并发、超时和重启下最多提交一次。
6. 每个任务都有 user、key、account、模型、quote、Ledger 和完整状态时间线。
7. 401/429/上游超时/提交不确定/任务失败均有正确调度和计费行为。
8. 管理台可完成订阅账号、用户、Plan、Key、任务和用量的完整操作，并能测试两类视频调用。
9. 单元、契约、集成、浏览器、重启恢复和两条受控 live 视频验收通过。
