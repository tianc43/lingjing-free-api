# 网页协议记录

本文记录实现时经过测试和代码契约**逆向验证**的灵境 Web 端行为，不是官方文档。以下路径、字段、状态、上传策略和错误文案都属于实现细节，**可能变化**；一旦网页端更新，应先用隔离账号重新验证 fixture 与契约，再更新适配器。

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
- `GET /joycreator/member/queryMember?pin=...`
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
