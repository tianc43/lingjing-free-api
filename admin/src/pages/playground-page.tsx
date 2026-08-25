import { useEffect, useMemo, useState } from "react";
import type { Job, PlaygroundInput, PlaygroundModel } from "../types";

type Kind = "image" | "video";

function priceLabel(pricing: unknown): string {
  if (pricing === null || typeof pricing !== "object") return "Price unavailable";
  const value = pricing as Record<string, unknown>;
  const points = typeof value.points === "number" ? value.points : null;
  return points === null ? "Dynamic price" : `${points} quoted points`;
}

function fieldValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "";
}

export function PlaygroundPage({ loadModels, run, getJob }: {
  loadModels(kind: Kind, refresh?: boolean): Promise<PlaygroundModel[]>;
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
  const selected = useMemo(() => models.find((model) => model.id === modelId) ?? null, [modelId, models]);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setModels([]); setModelId(""); setParameters({});
    void loadModels(kind).then((next) => {
      if (!active) return;
      setModels(next); setModelId(next[0]?.id ?? "");
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not load models");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [kind, loadModels]);

  useEffect(() => {
    if (job === null || !["queued", "submitting", "discovering", "processing"].includes(job.status)) return;
    const timer = window.setInterval(() => {
      void getJob(job.id).then(setJob).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [getJob, job]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!modelId || !prompt.trim()) { setError("Choose a model and enter a prompt."); return; }
    if(kind==="video"&&videoMode==="image-to-video"&&inputImage===undefined){setError("Choose a first-frame image.");return;}
    setRunning(true); setError(""); setJob(null);
    try {
      setJob(await run({ kind, model: modelId, prompt: prompt.trim(), ...(kind === "video" ? { mode: videoMode } : {}), ...(inputImage===undefined?{}:{input_image:inputImage}), parameters }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Test request failed");
    } finally { setRunning(false); }
  };

  const dynamicParameters = selected?.parameters.filter((parameter) => parameter.key !== "prompt" && parameter.type !== "image-list") ?? [];
  return <div className="playground-page"><header className="page-heading"><div><p className="eyebrow">Live request lab</p><h1 tabIndex={-1}>Playground</h1><p>Send a controlled text-only request through the active subscription pool.</p></div><span className="charge-warning">Real requests may consume points</span></header><div className="playground-layout"><form className="data-region playground-form" onSubmit={(event) => void submit(event)} aria-busy={running}><div className="segmented" role="group" aria-label="Generation type"><button type="button" aria-pressed={kind === "image"} onClick={() => setKind("image")}>Image</button><button type="button" aria-pressed={kind === "video"} onClick={() => setKind("video")}>Video</button></div>{kind==="video"&&<label>Video mode<select value={videoMode} onChange={event=>{setVideoMode(event.target.value as typeof videoMode);setInputImage(undefined);}}><option value="text-to-video">Text to video</option><option value="image-to-video">Image to video</option></select></label>}<label>Model<select disabled={loading} value={modelId} onChange={(event) => { setModelId(event.target.value); setParameters({}); }}><option value="">{loading ? "Loading models…" : "Choose a model"}</option>{models.map((model) => <option key={model.id} value={model.id}>{model.display_name}</option>)}</select></label>{selected !== null && <p className="model-meta"><span>{selected.display_name}</span><span>{priceLabel(selected.pricing)}</span></p>}<label>Prompt<textarea rows={6} maxLength={8000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={kind === "image" ? "A quiet coastal observatory at blue hour…" : "Locked camera, clouds move slowly over the mountains…"} /></label>{kind==="video"&&videoMode==="image-to-video"&&<label>First frame<input type="file" accept="image/png,image/jpeg,image/webp" required onChange={event=>{const file=event.target.files?.[0];if(!file){setInputImage(undefined);return;}const reader=new FileReader();reader.onload=()=>setInputImage(typeof reader.result==="string"?reader.result:undefined);reader.readAsDataURL(file);}}/></label>}{dynamicParameters.length > 0 && <fieldset className="parameter-grid"><legend>Model parameters</legend>{dynamicParameters.map((parameter) => <label key={parameter.key}>{parameter.display_name}{parameter.type === "enum" ? <select value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: event.target.value }))}><option value="">Choose…</option>{parameter.options?.map((option) => <option key={option}>{option}</option>)}</select> : parameter.type === "boolean" ? <select value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: event.target.value === "true" }))}><option value="">Default</option><option value="true">True</option><option value="false">False</option></select> : <input type={parameter.type === "number" ? "number" : "text"} min={parameter.minimum} max={parameter.maximum} value={fieldValue(parameters[parameter.key] ?? parameter.default)} onChange={(event) => setParameters((current) => ({ ...current, [parameter.key]: parameter.type === "number" ? Number(event.target.value) : event.target.value }))} />}</label>)}</fieldset>}<button className="run-button" disabled={running || loading || !modelId}>{running ? "Submitting…" : `Run ${kind} test`}</button>{error && <p className="field-error" role="alert">{error}</p>}</form><aside className="data-region result-panel" aria-live="polite"><div><p className="eyebrow">Response</p><h2>Request status</h2></div>{job === null ? <div className="result-empty"><span aria-hidden="true">↗</span><p>Your task ID and live status will appear here.</p></div> : <div className="job-result"><span className={`status-pill status-${job.status === "completed" ? "ready" : job.status === "failed" ? "unhealthy" : "unknown"}`}>{job.status}</span><dl><div><dt>Task ID</dt><dd><code>{job.id}</code></dd></div><div><dt>Account</dt><dd>{job.account_name}</dd></div><div><dt>Model</dt><dd>{job.model}</dd></div><div><dt>Quoted points</dt><dd>{job.quoted_points ?? "Pending"}</dd></div></dl>{job.status === "completed" && job.outputs.length>0 && <div className="media-results">{job.outputs.map((output,index)=>job.kind==="video"?<video key={output.url} controls poster={output.poster_url??undefined} src={output.url} aria-label={`Generated video ${String(index+1)}`}/>:<img key={output.url} src={output.url} alt={`Generated image ${String(index+1)}`}/>)}</div>}<a href="/admin/tasks">Open task monitor</a></div>}</aside></div></div>;
}
