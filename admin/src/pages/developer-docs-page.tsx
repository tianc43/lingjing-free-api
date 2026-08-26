import{useMemo,useState}from"react";const markdown=`# 灵境视频 API 调用指南（Agent 版）

## 基础信息

- Base URL: http://127.0.0.1:8010
- Authentication: Bearer fixture-project-api-key
- Content-Type: application/json
- 创建视频默认返回 HTTP 202；使用 Location 或 job.id 查询状态。
- 每次创建请求都应发送唯一的 Idempotency-Key（8–200 字符）。相同 Key 只能重放同一请求。

## 1. 查询可用模型

\`\`\`bash
curl -sS http://127.0.0.1:8010/v1/models?type=video \\
  -H "Authorization: Bearer fixture-project-api-key"
\`\`\`

模型、参数名、可选值来自实时灵境目录；不要猜测 model、duration、resolution 或其他枚举。

## 2. 文生视频

\`\`\`bash
curl -sS http://127.0.0.1:8010/v1/videos \\
  -H "Authorization: Bearer fixture-project-api-key" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: t2v-agent-0001" \\
  -d '{
    "model": "MODEL_ID",
    "mode": "text-to-video",
    "prompt": "固定镜头，云海缓慢流动，无文字",
    "parameters": {
      "duration": 5,
      "resolution": "1080P",
      "ratio": "16:9",
      "audio": false
    }
  }'
\`\`\`

## 3. 图生视频（multipart）

\`\`\`bash
curl -sS http://127.0.0.1:8010/v1/videos \\
  -H "Authorization: Bearer fixture-project-api-key" \\
  -H "Idempotency-Key: i2v-agent-0001" \\
  -F "model=MODEL_ID" \\
  -F "mode=image-to-video" \\
  -F "prompt=镜头缓慢推进，画面自然稳定，无文字" \\
  -F 'parameters={"duration":5,"resolution":"1080P","ratio":"16:9","audio":false}' \\
  -F "input_images[]=@./first-frame.jpg;type=image/jpeg"
\`\`\`

也可先创建持久上传，再把完成后的 Asset ID 放入 input_asset_ids。不要把临时上游 URL 当成长期资产。

## 4. 查询任务

\`\`\`bash
curl -sS http://127.0.0.1:8010/v1/videos/JOB_ID \\
  -H "Authorization: Bearer fixture-project-api-key"
\`\`\`

状态：queued、submitting、discovering、processing、unknown、completed、failed。

- completed：读取 outputs。输出归档后 URL 为 /v1/assets/ASSET_ID。
- unknown：提交可能已经收费，不得创建替代任务或重试 executeByApiId；继续查询原 Job。
- failed：依据 error.code 修正输入；仅在 submitted_at 为空或系统明确释放预算时再决定新建请求。

## 5. 下载或播放输出

\`\`\`bash
curl -L http://127.0.0.1:8010/v1/assets/ASSET_ID \\
  -H "Authorization: Bearer fixture-project-api-key" \\
  -H "Range: bytes=0-1048575" \\
  -o video.part
\`\`\`

Asset 必须使用所属 Project 的 API Key；支持 HTTP Range。

## Agent 安全规则

1. 先查询 /v1/models，再构造参数。
2. 创建请求必须带 Idempotency-Key。
3. 收到 202 后只轮询返回的原 Job。
4. unknown 绝不重提、换账号或换幂等键。
5. 不记录 API Key、Cookie、CSRF、上传签名 URL 或上游内部标识。
6. 公开调用只传 model、mode、prompt、parameters 和输入资产；不要传 apiId、refId、sceneCode、spaceId 或 modelCode。
7. 建议轮询间隔 5 秒；不要高频请求。
`;export function DeveloperDocsPage(){const[notice,setNotice]=useState(""),text=useMemo(()=>markdown,[]);const copy=async()=>{try{await navigator.clipboard.writeText(text);setNotice("Markdown 已复制，可直接粘贴给 Agent");}catch{setNotice("复制失败，请手动选择下方 Markdown");}};return <><header className="page-heading"><div><p className="eyebrow">开发者接入</p><h1>开发者文档</h1><p>面向 Agent 和自动化工具的视频生成调用规范。</p></div><button onClick={()=>void copy()}>复制 Markdown</button></header>{notice&&<p className="inline-notice" role="status">{notice}</p>}<section className="data-region"><div className="section-heading"><div><h2>Agent 调用指南</h2><p>复制完整文档后，Agent 可据此查询模型、创建任务、轮询状态并读取受控输出。</p></div></div><textarea className="developer-markdown mono" aria-label="Agent Markdown 开发文档" readOnly value={text} rows={34}/></section></>}


