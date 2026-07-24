import {
  mkdtempSync,
  writeFileSync
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type {
  FastifyInstance,
  InjectOptions,
  LightMyRequestResponse
} from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type RunningServer } from "../../src/index.js";
import type {
  LingjingTransport,
  ReadRequest
} from "../../src/lingjing/types.js";
import { removeTestDirectory } from "../helpers/cleanup.js";
import { liveDatabasePath } from "../live/live-helpers.js";

const API_KEY = "fixture-downstream-api-key";
const ADMIN_PASSWORD = "fixture-admin-password";

interface FixtureAsset {
  id: string;
  scene: string;
  modelCode: string;
  createTime: number;
  creationCode: string;
  taskId: string;
  reqParam: unknown;
  status: number;
}

interface AdminSession {
  cookie: string;
  csrfToken: string;
}

const imageModel = {
  apiId: "fixture-image-api",
  id: "fixture-image-api",
  modelName: "fixture-image",
  sourceType: "image-generation",
  modelCode: "fixture-image-code",
  refId: "fixture-image-ref",
  sceneCode: "fixture-image-scene",
  assetScene: "image-generation",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [{
    index: 1,
    fieldName: "prompt",
    fieldName4View: "Prompt",
    required: true,
    style: { type: "textarea" }
  }],
  pricing: { unit: "points", amount: 7 }
};

const videoModel = {
  apiId: "fixture-video-api",
  id: "fixture-video-api",
  modelName: "fixture-video",
  sourceType: "text-to-video",
  modelCode: "fixture-video-code",
  refId: "fixture-video-ref",
  sceneCode: "fixture-video-scene",
  assetScene: "text-to-video",
  uploadStrategy: "general",
  priceQuerySchema: null,
  parameters: [{
    index: 1,
    fieldName: "prompt",
    fieldName4View: "Prompt",
    required: true,
    style: { type: "textarea" }
  }],
  pricing: { unit: "points", amount: 0 }
};

class LifecycleTransport implements LingjingTransport {
  private readonly assets: FixtureAsset[] = [];
  private readonly taskKinds = new Map<string, "image" | "video">();
  private submissions = 0;

  submissionCount(): number {
    return this.submissions;
  }

  read<T>(path: string, init?: ReadRequest): Promise<T> {
    const accountResponses: Record<string, unknown> = {
      "/api/user/describeBaseInfo": {},
      "/joycreator/team/space/menu/list": [{ spaceId: 0 }],
      "/joycreator/member/queryMember?pin=fixture-pin": {
        membership: "fixture"
      },
      "/api/wallet/describeAccountCoupons": {
        pointsBalance: 100,
        couponBalance: 0,
        availableAmount: 100,
        totalBalance: 100
      }
    };
    if (Object.hasOwn(accountResponses, path)) {
      return Promise.resolve(accountResponses[path] as T);
    }
    if (path === "/joycreator/AIModelApiConsole/getBySourceType") {
      const body = init?.body as { sourceType?: string } | undefined;
      return Promise.resolve({
        result: body?.sourceType === "text-to-video"
          ? [videoModel]
          : [imageModel]
      } as T);
    }
    if (path === "/joycreator/AIModelApiConsole/getByApiId") {
      const body = init?.body as { apiId?: string } | undefined;
      return Promise.resolve({
        result: body?.apiId === videoModel.apiId
          ? [videoModel]
          : [imageModel]
      } as T);
    }
    if (path === "/joycreator/space/asset/list") {
      return Promise.resolve({ records: [...this.assets] } as T);
    }
    if (path === "/openApi/modelmarket/describeUserTask") {
      const body = init?.body as {
        params?: { taskId?: string };
      } | undefined;
      const taskId = body?.params?.taskId ?? "";
      const kind = this.taskKinds.get(taskId);
      return Promise.resolve({
        data: {
          task: {
            taskId,
            status: 1,
            taskResults: kind === "video"
              ? [{
                  videoUrl: `https://media.example/${taskId}.mp4`,
                  frameUrl: `https://media.example/${taskId}.jpg`,
                  width: 1920,
                  height: 1080,
                  duration: 5
                }]
              : [{
                  imageUrl: `https://media.example/${taskId}.png`,
                  width: 1024,
                  height: 1024
                }]
          }
        }
      } as T);
    }
    return Promise.reject(new Error(`Unexpected lifecycle read ${path}`));
  }

  submitOnce<T>(path: string, body: unknown): Promise<T> {
    if (path !== "/joycreator/AIModelApiConsole/executeByApiId") {
      return Promise.reject(new Error(`Unexpected lifecycle submit ${path}`));
    }
    this.submissions += 1;
    const payload = body as { apiId?: string };
    const kind = payload.apiId === videoModel.apiId ? "video" : "image";
    const suffix = String(this.submissions);
    const taskId = `fixture-${kind}-task-${suffix}`;
    this.taskKinds.set(taskId, kind);
    this.assets.push({
      id: `fixture-${kind}-asset-${suffix}`,
      scene: kind === "video"
        ? videoModel.assetScene
        : imageModel.assetScene,
      modelCode: kind === "video"
        ? videoModel.modelCode
        : imageModel.modelCode,
      createTime: Date.now() + 1,
      creationCode: `fixture-${kind}-creation-${suffix}`,
      taskId,
      reqParam: body,
      status: 0
    });
    return Promise.resolve({} as T);
  }

  uploadApi<T>(): Promise<T> {
    return Promise.reject(new Error("Lifecycle fixture does not upload media"));
  }

  putSigned(): Promise<never> {
    return Promise.reject(new Error("Lifecycle fixture does not upload media"));
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((cause) => {
      if (cause === undefined) resolve();
      else reject(cause);
    });
  });
  if (address === null || typeof address === "string") {
    throw new Error("Could not reserve a lifecycle test port");
  }
  return address.port;
}

function createVersionOneDatabase(path: string): void {
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      INSERT INTO schema_migrations(version, applied_at) VALUES (1, 1);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_type TEXT NOT NULL,
        model TEXT NOT NULL,
        api_id TEXT NOT NULL,
        model_code TEXT,
        expected_asset_scene TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        idempotency_key_hash TEXT,
        space_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        creation_code TEXT,
        upstream_task_id TEXT,
        upstream_fingerprint TEXT,
        submitted_at INTEGER,
        discovered_at INTEGER,
        completed_at INTEGER,
        failed_at INTEGER,
        unknown_hold_until INTEGER,
        error_code TEXT,
        result_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE job_status_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO jobs (
        id, kind, source_type, model, api_id, model_code,
        expected_asset_scene, request_fingerprint, idempotency_key_hash,
        space_id, status, failed_at, error_code, created_at, updated_at
      ) VALUES (
        'job_v1_fixture', 'image', 'image-generation', 'fixture-image',
        'fixture-image-api', NULL, 'image-generation', '${"a".repeat(64)}',
        NULL, 0, 'failed', 1, 'fixture_v1_failure', 1, 1
      );
    `);
  } finally {
    database.close();
  }
}

async function fixtureEnvironment(
  directory: string,
  dbPath: string
): Promise<Record<string, string | undefined>> {
  const storageStatePath = join(directory, "storage-state.json");
  const profilePath = join(directory, "session-profile.json");
  writeFileSync(storageStatePath, JSON.stringify({
    cookies: [{
      name: "csrfToken",
      value: "fixture-csrf",
      domain: "lingjing.jdcloud.com",
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: true,
      sameSite: "Lax"
    }]
  }));
  writeFileSync(profilePath, JSON.stringify({ originPin: "fixture-pin" }));
  return {
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(await availablePort()),
    LINGJING_API_KEY: API_KEY,
    LINGJING_ADMIN_PASSWORD: ADMIN_PASSWORD,
    SESSION_MODE: "browser-state",
    LINGJING_STORAGE_STATE: storageStatePath,
    LINGJING_SESSION_PROFILE: profilePath,
    LINGJING_DATA_DIRECTORY: join(directory, "data"),
    DB_PATH: dbPath,
    LOG_LEVEL: "silent",
    DOCS_ENABLED: "false",
    TASK_POLL_INTERVAL_MS: "1",
    ASSET_DISCOVERY_TIMEOUT_MS: "100",
    UNKNOWN_CAPACITY_HOLD_MS: "100",
    IMAGE_WAIT_TIMEOUT_MS: "1000",
    VIDEO_WAIT_TIMEOUT_MS: "1000"
  };
}

async function login(app: FastifyInstance): Promise<AdminSession> {
  const response = await app.inject({
    method: "POST",
    url: "/admin/api/login",
    payload: { password: ADMIN_PASSWORD }
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
    ?.split(";")[0];
  if (cookie === undefined) throw new Error("Admin cookie was not set");
  return {
    cookie,
    csrfToken: response.json<{ csrf_token: string }>().csrf_token
  };
}

function adminMutate(
  app: FastifyInstance,
  session: AdminSession,
  options: {
    method: "POST" | "PATCH";
    url: string;
    payload?: object;
  }
): Promise<LightMyRequestResponse> {
  const injectOptions: InjectOptions = {
    ...options,
    headers: {
      cookie: session.cookie,
      "x-csrf-token": session.csrfToken
    }
  };
  return app.inject(injectOptions);
}

function generationHeaders(idempotencyKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${API_KEY}`,
    "idempotency-key": idempotencyKey
  };
}

describe("multi-account administrator lifecycle", () => {
  const directories: string[] = [];
  let runtime: RunningServer | undefined;

  afterEach(async () => {
    await runtime?.stop();
    runtime = undefined;
    for (const directory of directories.splice(0)) {
      removeTestDirectory(directory);
    }
  });

  it("uses an explicitly authorized persistent database for live acceptance", () => {
    expect(liveDatabasePath({}, "fixture-temporary")).toBe(
      join("fixture-temporary", "jobs.sqlite")
    );
    expect(liveDatabasePath({
      LIVE_ACCEPTANCE_DB_PATH: "fixture-persistent.sqlite"
    }, "fixture-temporary")).toBe("fixture-persistent.sqlite");
  });

  it("migrates legacy state, enforces a raced budget, and persists it across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lingjing-admin-lifecycle-"));
    directories.push(directory);
    const dbPath = join(directory, "jobs.sqlite");
    createVersionOneDatabase(dbPath);
    const env = await fixtureEnvironment(directory, dbPath);
    const transport = new LifecycleTransport();

    runtime = await startServer(env, { transport });
    expect(runtime.dependencies.config.dataDirectory).toBe(
      env.LINGJING_DATA_DIRECTORY
    );
    const firstSession = await login(runtime.app);
    const migrated = await runtime.app.inject({
      url: "/admin/api/accounts",
      headers: { cookie: firstSession.cookie }
    });
    expect(migrated.statusCode).toBe(200);
    expect(migrated.json()).toMatchObject({
      accounts: [{
        id: "legacy",
        name: "Legacy account",
        enabled: true,
        has_session: true
      }]
    });

    const created = await adminMutate(runtime.app, firstSession, {
      method: "POST",
      url: "/admin/api/accounts",
      payload: {
        name: "Disabled reserve",
        priority: 10,
        daily_point_limit: 0,
        monthly_point_limit: 0
      }
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      account: {
        name: "Disabled reserve",
        enabled: false
      }
    });

    const limited = await adminMutate(runtime.app, firstSession, {
      method: "PATCH",
      url: "/admin/api/accounts/legacy",
      payload: {
        daily_point_limit: 7,
        monthly_point_limit: 7
      }
    });
    expect(limited.statusCode).toBe(200);
    expect(limited.json()).toMatchObject({
      account: {
        daily_point_limit: 7,
        monthly_point_limit: 7
      }
    });

    const attempts = await Promise.all([
      runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: generationHeaders("fixture-race-image-a"),
        payload: {
          model: "fixture-image",
          prompt: "fixture lifecycle image",
          response_format: "url"
        }
      }),
      runtime.app.inject({
        method: "POST",
        url: "/v1/images/generations",
        headers: generationHeaders("fixture-race-image-b"),
        payload: {
          model: "fixture-image",
          prompt: "fixture lifecycle image",
          response_format: "url"
        }
      })
    ]);
    const succeeded = attempts.filter((response) => response.statusCode === 200);
    const exhausted = attempts.filter((response) => response.statusCode === 429);
    expect(succeeded).toHaveLength(1);
    expect(exhausted).toHaveLength(1);
    expect(transport.submissionCount()).toBe(1);
    const imageBody = succeeded[0]?.json<{
      created: number;
      job_id: string;
      data: Array<{ url: string }>;
    }>();
    if (imageBody === undefined) {
      throw new Error("Lifecycle image response did not contain a job ID");
    }
    expect(typeof imageBody.created).toBe("number");
    expect(imageBody.job_id).toMatch(/^job_/u);
    expect(imageBody.data).toHaveLength(1);
    expect(imageBody.data[0]?.url).toMatch(/\.png$/u);
    const generatedJobId = imageBody.job_id;

    await runtime.stop();
    runtime = undefined;
    env.PORT = String(await availablePort());
    runtime = await startServer(env, { transport });
    const secondSession = await login(runtime.app);
    const accounts = await runtime.app.inject({
      url: "/admin/api/accounts",
      headers: { cookie: secondSession.cookie }
    });
    const accountRows = accounts.json<{
      accounts: Array<{
        id: string;
        name: string;
        enabled: boolean;
        daily_point_limit: number;
        monthly_point_limit: number;
        daily_used_points: number;
        monthly_used_points: number;
      }>;
    }>().accounts;
    expect(accountRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "legacy",
        daily_point_limit: 7,
        monthly_point_limit: 7,
        daily_used_points: 7,
        monthly_used_points: 7
      }),
      expect.objectContaining({
        name: "Disabled reserve",
        enabled: false
      })
    ]));

    const jobs = await runtime.app.inject({
      url: "/admin/api/jobs?limit=100",
      headers: { cookie: secondSession.cookie }
    });
    expect(jobs.statusCode).toBe(200);
    const jobRows = jobs.json<{
      jobs: Array<{
        id: string;
        account_name: string;
        quoted_points: number | null;
        budget_state: string | null;
        status: string;
      }>;
    }>().jobs;
    expect(jobRows).toContainEqual(expect.objectContaining({
      id: "job_v1_fixture",
      account_name: "Legacy account",
      budget_state: "released"
    }));
    expect(jobRows).toContainEqual(expect.objectContaining({
      id: generatedJobId,
      account_name: "Legacy account",
      quoted_points: 7,
      budget_state: "charged",
      status: "completed"
    }));

    const video = await runtime.app.inject({
      method: "POST",
      url: "/v1/videos/generations",
      headers: generationHeaders("fixture-lifecycle-video"),
      payload: {
        model: "fixture-video",
        prompt: "fixture lifecycle video",
        mode: "text-to-video"
      }
    });
    expect(video.statusCode).toBe(200);
    const videoBody = video.json<{
      created: number;
      job_id: string;
      data: Array<{
        url: string;
        poster_url: string | null;
        width: 1920,
        height: 1080,
        duration: 5,
        format: string | null;
      }>;
    }>();
    expect(typeof videoBody.created).toBe("number");
    expect(videoBody.job_id).toMatch(/^job_/u);
    expect(videoBody.data).toHaveLength(1);
    expect(videoBody.data[0]).toMatchObject({
      width: 1920,
      height: 1080,
      duration: 5,
      format: null
    });
    expect(videoBody.data[0]?.url).toMatch(/\.mp4$/u);
    expect(videoBody.data[0]?.poster_url).toMatch(/\.jpg$/u);
  });
});
