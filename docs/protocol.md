# 网页协议记录

本文记录实现时经过测试和代码契约**逆向验证**的灵境 Web 端行为，不是官方文档。以下路径、字段、状态、上传策略和错误文案都属于实现细节，**可能变化**；一旦网页端更新，应先用隔离账号重新验证 fixture 与契约，再更新适配器。

## 2026-08-25 已登录浏览器采集与受控实测

本轮使用已登录的网页端，读取首页和“视频生成”页加载的请求、可见表单及已加载前端脚本；所有 `_t` 时间戳、账号标识、Cookie、CSRF 和完整查询值均未记录。随后经明确授权完成一笔受控文生视频实测；图生视频已完成参数和首帧选择，但因余额不足没有受理任务。

| 模块 | 路径与方法 | 本轮证据 | 已确认的输入/用途 |
|---|---|---|---|
| 登录与账号 | `GET /api/auth/validation`、`GET /api/user/describeBaseInfo` | 页面实际请求 | 校验会话，读取账号基础信息。 |
| 钱包与会员 | `GET /api/wallet/describeAccountCoupons`、`GET /api/memberSubscription/messages`、`GET /joycreator/member/queryMemberList` | 页面实际请求 | 点数、订阅消息和会员列表。 |
| 空间与资产 | `GET /joycreator/team/space/menu/list`、`GET /joycreator/space/asset/list` | 页面实际请求 | 后者当前可见查询包含 `spaceId`、`assetType`、`currentPage`、`pageSize`。 |
| 模型目录 | `POST /joycreator/AIModelApiConsole/getBySourceType` | 页面实际请求 + 已加载脚本 | 请求体为 `{ "sourceType": "..." }`；视频页由此加载动态模型与参数。 |
| 单模型详情 | `POST /joycreator/AIModelApiConsole/getByApiId` | 已加载脚本 | 请求体为 `{ "apiId": "..." }`。 |
| 报价 | `POST /joycreator/AIModelApiConsole/calculatePrice` | 页面实际请求 + 已加载脚本 | 随当前模型/参数刷新报价；必须在提交前重新查询。 |
| 提交 | `POST /joycreator/AIModelApiConsole/executeByApiId` | 已加载脚本 + 文生视频实测受理 | 通用模型执行入口；原始请求体仍需由动态目录和表单构造，禁止硬编码。 |
| 图生素材上传 | `POST /joycreator/AIModelApiConsole/uploadMaterials` | 已加载脚本 | `multipart/form-data`：`sceneCode`、`modelCode`、`spaceId`、`file`。 |
| 任务读取 | `POST /openApi/modelmarket/describeUserTask` | 已加载脚本 | 请求体为 `{ "params": { "taskId": "..." } }`。 |

视频页当前可见三种模式：文生视频、图生视频、参考生视频。图生视频要求首帧图；当前表单暴露模型、时长、分辨率、画幅和“生成音频”开关，说明这些都必须从动态模型目录而不是写死的枚举中取值。

任务读取的当前前端处理字段包括 `status`、`url`、`watermarkUrl`、`imageUrl`、`width`、`height`、`taskType`、`taskResults`、`reqParam`、`name` 和 `errMsg`。这证明轮询响应不能只依赖单一输出 URL。

### 受控视频验收记录

| 流程 | 运行时模型与参数 | 页面报价 | 结果 |
|---|---|---:|---|
| 文生视频 | Seedance 2.0 mini；4s；480p；16:9；同步音频关闭；联网搜索关闭；最小无敏感提示词 | 92 点 | `executeByApiId` 已受理，任务立即进入“生成中”，随后在作品流中出现可播放的 4s 视频。页面余额从 170 变为 76；显示差额与报价不完全相同，账务必须以平台结算记录为准。 |
| 图生视频 | Seedance 2.0 mini；4s；480p；16:9；同步音频关闭；联网搜索关闭；已有生成图首帧 | 92 点 | 当前余额 76，低于报价；未受理任务，未重复提交。 |
| 图生视频备选 | 海螺 Hailuo-2.3-Fast；默认 6s；1080p | 231 点 | 高于当前余额，未提交。 |
| 图生视频（新账号） | Seedance-1.5-pro；5s；720p；16:9；同步音频关闭；已有图生作品首帧；最小无敏感提示词 | 32 点 | `executeByApiId` 已受理，作品流立即新增“生成中”任务；两次短轮询后仍为异步处理。页面未展示 taskId，禁止重新提交。 |

文生与图生均由动态目录决定 `apiId`、`refId`、`sceneCode`、`modelCode`、参数 `idx`、可选值和报价查询结构；这些内部 ID 不在浏览器可见 DOM 中，应先调用 `getBySourceType`，再以 `getByApiId` 获取详情后构造请求。图生使用现有平台资产作为首帧时不经过 `uploadMaterials`；该 multipart 路径仅适用于外部文件需要上送的模型策略。

网页作品流的“一键同款”会导航到 `/image-to-video?from=assets&generationId=...` 并回填首帧、模型、提示词和动态参数。该路径可验证已有资产复用的图生流程，但不得把 `generationId` 当作稳定公开 API，也不得在日志中记录其值。

**实现前结论：**下一步应把上述真实路径收敛为一个协议适配层，再实现账号、模型、报价、上传、提交、资产发现和轮询。提交必须绑定模型详情和报价快照、只发送一次；余额不足时要在提交前失败，绝不降级到其他收费系统或自动重试。

## 会话、来源与信封

默认 origin 为 `https://lingjing.jdcloud.com`。Playwright `storage-state.json` 载入 CookieJar；名为 `csrfToken` 的 Cookie 值会镜像到每个上游请求的 `x-csrf-token` header。服务接收 `Set-Cookie` 并以私有权限原子回写状态文件。Cookie、CSRF、`originPin` 和完整 URL 查询串不得进入日志。

常见响应信封为：

```json
{
  "error": null,
  "result": {}
}
```

非 2xx、非对象响应、有 `error` 或无法解析 JSON 都不能当作业务成功。已验证的错误分类包括登录失效、CSRF 失效、点数不足、内容审核、限流与权限拒绝；未知形态映射为通用上游错误。

目录使用三种 `sourceType`：

- `image-generation`
- `text-to-video`
- `image-to-video`

当前读取路径：

- `POST /joycreator/AIModelApiConsole/getBySourceType`
- `POST /joycreator/AIModelApiConsole/getByApiId`
- `GET /api/user/describeBaseInfo`
- `GET /joycreator/team/space/menu/list`
- `GET /joycreator/member/queryMemberList`
- `GET /api/wallet/describeAccountCoupons`

目录对外只返回白名单字段。内部 `apiId`、`refId`、场景、价格签名与上传元数据不会原样透出。

## 生成提交与 exactly-once

提交前会重新按 `apiId` 读取模型、校验动态参数、查询账号空间，并构造：

```json
{
  "apiId": "upstream-api-id",
  "params": [
    {"idx": "field-id", "name": "Prompt", "values": "example"}
  ],
  "refId": "upstream-ref-id",
  "spaceId": 0
}
```

若目录声明计价查询字段，payload 还可能包含派生的 `priceQueryResult`。精确提交端点是：

```text
POST /joycreator/AIModelApiConsole/executeByApiId
```

该请求使用 `submitOnce`，不会自动重放。只有无计费副作用的 read 请求可在传输不确定、CSRF、限流或一般上游错误下进行有界重试。提交结果不确定时，进入资产发现而不是重新提交。

## 输入媒体与上传

外部 API 接受：

- 公网 `http:` / `https:` URL；
- `data:` URI；
- `multipart/form-data` 图片文件。

远程 URL 在每次请求及最多 3 次重定向时验证：拒绝凭据 URL、本机、私网、保留 IPv4/IPv6；DNS 解析后固定连接地址，阻止 DNS rebinding。尺寸、MIME、单请求临时空间与全局临时空间都有上限。

模型目录决定上传策略：

1. `materials`：`POST /joycreator/AIModelApiConsole/uploadMaterials`，字段为 `sceneCode`、`modelCode`、`spaceId` 和 `file`。
2. `general`：
   - `POST /joycreator/upload/init`
   - 对返回的一次性 HTTPS signed URL 执行单段或最多 3 并发分段 `PUT`
   - `POST /joycreator/upload/complete`
   - 失败且已取得 uploadId 时尽力 `POST /joycreator/upload/cancel`

Signed URL 必须是 HTTPS、不得带 URL 用户信息、不得回到灵境 origin，且只允许消费一次；上游 Cookie、CSRF、Origin 和 Authorization 不会被转发到对象存储。

## 资产发现与任务状态

提交前先读取资产基线；提交后从以下路径按页发现新资产：

```text
GET /joycreator/space/asset/list
```

当前查询字段为 `assetType=1`、`spaceId`、`currentPage`、`pageSize=20`，最多 5 页。候选必须晚于提交时间容差、未出现在基线、场景匹配，并在可用时同时匹配模型和请求指纹。只有唯一候选才会绑定；零个或多个候选不会猜测。

绑定上游 taskId 后，精确轮询端点是：

```text
POST /openApi/modelmarket/describeUserTask
```

请求体为 `{"params":{"taskId":"..."}}`。当前逆向状态映射：

| 上游 status | 本地状态 |
|---:|---|
| `0` | `processing` |
| `1` | 有可规范化输出时 `completed`，否则继续等待/资产补查 |
| `2` | `failed`，code 为 `lingjing_task_failed` |
| 其他或畸形 | 不臆测；保留原任务并按恢复逻辑处理 |

公开任务还会经过 `queued → submitting → discovering → processing`。无法确认提交或唯一资产时为 `unknown`；它不是“可以安全重提”的证明。恢复窗口内服务继续发现/轮询并保留并发容量；重启会从 SQLite 恢复持久任务。

## 变更验证清单

网页端变化后至少验证：

1. 登录状态文件仍包含可镜像的 CSRF Cookie。
2. 账号、空间、钱包和三类模型目录信封仍能正常解包。
3. 模型参数、计价字段、上传策略和场景元数据没有漂移。
4. 提交端点仍只发一次，断连路径仍进入发现/`unknown`。
5. 资产列表分页、任务端点和 `0/1/2` 状态语义仍成立。
6. 输出 URL、poster、宽高、时长和格式规范化仍覆盖真实响应。
