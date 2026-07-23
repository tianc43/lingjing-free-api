export interface LingjingAsset {
  id: string;
  scene: string | null;
  modelCode: string | null;
  url: string | null;
  waterUrl: string | null;
  watermarkUrl: string | null;
  imageUrl: string | null;
  videoUrl: string | null;
  frameUrl: string | null;
  createTime: number;
  creationCode: string | null;
  status: number | string | null;
  taskId: string | null;
  taskResults: unknown;
  errMsg: string | null;
  reqParam: unknown;
  width: number | null;
  height: number | null;
  duration: number | null;
  fps: number | null;
  taskType: string | null;
  name: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : null;
}

function number(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (
    typeof value === "string"
    && value.trim().length > 0
    && Number.isFinite(Number(value))
  ) {
    return Number(value);
  }
  return null;
}

export function normalizeLingjingAsset(value: unknown): LingjingAsset | null {
  const item = record(value);
  if (item === null) return null;
  const id = string(item.id ?? item.assetId ?? item.creationId);
  const createTime = number(
    item.createTime ?? item.createdAt ?? item.createTimestamp
  );
  if (id === null || createTime === null) return null;

  const status = item.status;
  return {
    id,
    scene: string(item.scene ?? item.sceneCode),
    modelCode: string(item.modelCode),
    url: string(item.url),
    waterUrl: string(item.waterUrl),
    watermarkUrl: string(item.watermarkUrl),
    imageUrl: string(item.imageUrl),
    videoUrl: string(item.videoUrl),
    frameUrl: string(item.frameUrl ?? item.posterUrl),
    createTime,
    creationCode: string(item.creationCode),
    status: typeof status === "number" || typeof status === "string"
      ? status
      : null,
    taskId: string(item.taskId),
    taskResults: item.taskResults ?? null,
    errMsg: string(item.errMsg ?? item.errorMessage),
    reqParam: item.reqParam ?? item.requestParam ?? null,
    width: number(item.width),
    height: number(item.height),
    duration: number(item.duration),
    fps: number(item.fps),
    taskType: string(item.taskType),
    name: string(item.name)
  };
}

function findArray(
  value: unknown,
  depth = 0,
  seen = new Set<object>()
): unknown[] | null {
  if (Array.isArray(value)) return (value as readonly unknown[]).slice();
  if (depth >= 4) return null;
  const item = record(value);
  if (item === null || seen.has(item)) return null;
  seen.add(item);

  for (const key of ["records", "list", "rows", "assets", "items"]) {
    const candidate = item[key];
    if (Array.isArray(candidate)) {
      return (candidate as readonly unknown[]).slice();
    }
  }
  for (const key of ["data", "result", "page", "pageInfo"]) {
    const candidate = findArray(item[key], depth + 1, seen);
    if (candidate !== null) return candidate;
  }
  return null;
}

export function assetsFromResponse(value: unknown): LingjingAsset[] {
  return (findArray(value) ?? [])
    .map((item) => normalizeLingjingAsset(item))
    .filter((item): item is LingjingAsset => item !== null);
}
