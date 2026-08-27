import { useEffect, useMemo, useState } from "react";
import type { Job, PlaygroundInput, PlaygroundModel, PlaygroundQuoteInput } from "../types";

type Kind = "image" | "video";

function priceLabel(pricing: unknown): string {
  if (pricing === null || typeof pricing !== "object") return "暂无价格";
  const value = pricing as Record<string, unknown>;
  const points = typeof value.points === "number" ? value.points : null;
  return points === null ? "动态价格" : `预计 ${points} 点`;
}

function fieldValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

export function PlaygroundPage({ loadModels, quote, run, getJob }: {
  loadModels(kind: Kind, mode?: "text-to-video" | "image-to-video", refresh?: boolean): Promise<PlaygroundModel[]>;
  quote(input: PlaygroundQuoteInput): Promise<{ points: number }>;
  run(input: PlaygroundInput): Promise<Job>;
  getJob(id: string): Promise<Job>;
}) {
  const [kind, setKind] = useState<Kind>("image");
  const [models, setModels] = useState<PlaygroundModel[]>([]);
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [videoMode,setVideoMode]=useState<"text-to-video"|"image-to-video">("text-to-video");
  const [inputImage,setInputImage]=useState<string|undefined>();
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [job, setJob] = useState<Job | null>(null);
  const [livePoints, setLivePoints] = useState<number | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState(false);
  const selected = useMemo(() => models.find((model) => model.id === modelId) ?? null, [modelId, models]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setModels([]); setModelId(""); setParameters({});
    void loadModels(kind, kind === "video" ? videoMode : undefined).then((next) => {
      if (!active) return;
      setModels(next); setModelId(next[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "无法加载模型");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, loadModels, videoMode]);

  useEffect(() => {
    if (kind !== "video" || selected === null) {
      setLivePoints(null); setQuoteLoading(false); setQuoteError(false);
      return;
    }
    let active = true;
    setQuoteLoading(true); setQuoteError(false); setLivePoints(null);
    const timer = window.setTimeout(() => {
      void quote({
        kind: "video",
        model: selected.id,
        mode: videoMode,
        parameters
      }).then((result) => {
        if (active) setLivePoints(result.points);
      }).catch(() => {
        if (active) setQuoteError(true);
      }).finally(() => {
        if (active) setQuoteLoading(false);
      });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [kind, parameters, quote, selected, videoMode]);

  useEffect(() => {
    if (job === null || !["queued", "submitting", "discovering", "processing"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void getJob(job.id).then(setJob).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [getJob, job]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!modelId || !prompt.trim()) { setError("请选择模型并输入提示词。"); return; }
    if(kind==="video"&&videoMode==="image-to-video"&&inputImage===undefined){setError("请选择首帧图片。");return;}
    setRunning(true); setError(""); setJob(null);
    try {
      setJob(await run({ kind, model: modelId, prompt: prompt.trim(), ...(kind === "video" ? { mode: videoMode } : {}), ...(inputImage===undefined?{}:{input_image:inputImage}), parameters }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "测试请求失败");
    } finally { setRunning(false); }
  };

  const dynamicParameters = selected?.parameters.filter((parameter) => parameter.key !== "prompt" && parameter.type !== "image-list") ?? [];
  return <div className="playground-page"><header className="page-heading"><div><p className="eyebrow">实时请求实验室</p><h1 tabIndex={-1}>生成测试</h1><p>通过当前可用的订阅账号池发起受控生成请求。</p></div><span className="charge-warning">真实请求可能消耗点数</span></header><div className="playground-layout"><form className="data-region playground-form" onSubmit={(event) => void submit(event)} aria-busy={running}><div className="segmented" role="group" aria-label="生成类型"><button type="button" aria-pressed={kind === "image"} onClick={() => setKind("image")}>图片</button><button type="button" aria-pressed={kind === "video"} onClick={() => setKind("video")}>视频</button></div>{kind==="video"&&<label>视频模式<select value={videoMode} onChange={event=>{setVideoMode(event.target.value as typeof videoMode);setInputImage(undefined);}}><option value="text-to-video">文生视频</option><option value="image-to-video">图生视频</option></select></label>}<label>模型<select disabled={loading} value={modelId} onChange={(event) => { setModelId(event.target.value); setParameters({}); }}><option value="">{loading ? "正在加载模型…" : "请选择模型"}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}</select></label>{selected !== null && <p className="model-meta"><span>{selected.display_name}</span><span>{kind === "video" ? quoteLoading ? "正在获取实时价格…" : livePoints !== null ? `预计 ${String(livePoints)} 点` : quoteError ? "实时价格暂不可用" : "动态价格" : priceLabel(selected.pricing)}</span></p>}<label>提示词<textarea rows={6} maxLength={8000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={kind === "image" ? "蓝调时刻，一座宁静的海岸天文台…" : "固定镜头，云层在群山上方缓慢移动…"} /></label>{kind==="video"&&videoMode==="image-to-video"&&<label>首帧图片<input type="file" accept="image/png,image/jpeg,image/webp" required onChange={event=>{const file=event.target.files?.[0];if(!file){setInputImage(undefined);return;}const reader=new FileReader();reader.onload=()=>setInputImage(typeof reader.result==="string"?reader.result:undefined);reader.readAsDataURL(file);}}/></label>}{!loading&&models.length===0&&error&&<section className="empty-state" role="status"><strong>请先连接灵境账号</strong><p>请前往“订阅账号”导入当前浏览器 Cookie，或在服务器运行 <code>npm run login</code>。</p><a href="/admin/accounts">打开订阅账号</a></section>}{dynamicParameters.length > 0 && <fieldset className="parameter-grid"><legend>模型参数</legend>{dynamicParameters.map((parameter) => <label key={parameter.key}>{parameter.display_name}{parameter.type === "enum" ? <select value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: event.target.value }))}><option value="">请选择…</option>{parameter.options?.map((option) => <option key={option}>{option}</option>)}</select> : parameter.type === "boolean" ? <select value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: event.target.value === "true" }))}><option value="">默认值</option><option value="true">是</option><option value="false">否</option></select> : <input type={parameter.type === "number" ? "number" : "text"} min={parameter.minimum} max={parameter.maximum} value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: parameter.type === "number" ? Number(event.target.value) : event.target.value }))} />}</label>)}</fieldset>}<button className="run-button" disabled={running || loading || !modelId}>{running ? "正在提交…" : kind === "image" ? "运行图片生成测试" : "运行视频生成测试"}</button>{error && <p className="field-error" role="alert">{error}</p>}</form><aside className="data-region result-panel" aria-live="polite"><div><p className="eyebrow">响应结果</p><h2>请求状态</h2></div>{job === null ? <div className="result-empty"><span aria-hidden="true">↗</span><p>任务 ID 和实时状态将在此显示。</p></div> : <div className="job-result"><span className={`status-pill status-${job.status === "completed" ? "ready" : job.status === "failed" ? "unhealthy" : "unknown"}`}>{job.status}</span><dl><div><dt>任务 ID</dt><dd><code>{job.id}</code></dd></div><div><dt>账号</dt><dd>{job.account_name}</dd></div><div><dt>模型</dt><dd>{job.model}</dd></div><div><dt>预计点数</dt><dd>{job.quoted_points ?? "待确认"}</dd></div></dl>{job.status === "completed" && job.outputs.length>0 && <div className="media-results">{job.outputs.map((output,index)=>job.kind==="video"?<video key={output.url} controls poster={output.poster_url??undefined} src={output.url} aria-label={`生成的视频 ${String(index+1)}`}/>:<img key={output.url} src={output.url} alt={`生成的图片 ${String(index+1)}`}/>)}</div>}<a href="/admin/tasks">打开任务监控</a></div>}</aside></div></div>;
}
