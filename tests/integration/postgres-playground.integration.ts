import { bootstrapPostgres } from "../../src/persistence/postgres-bootstrap.js";
import { createPostgresApiRuntime } from "../../src/persistence/postgres-api-runtime.js";
import { createPostgresRepositoryGraph } from "../../src/persistence/postgres-repository-graph.js";
import type { VideoQuoteInput } from "../../src/lingjing/postgres-quote-resolver.js";

const pg = await bootstrapPostgres(
  process.env["DATABASE_URL"]
    ?? "postgres://lingjing:fixture-postgres@127.0.0.1:15432/lingjing"
);
const graph = createPostgresRepositoryGraph(pg);
await graph.accounts.update("legacy", { enabled: true });
const models = [{
  id: "video",
  apiId: "api",
  displayName: "Fixture Video",
  parameters: [{
    idx: "1",
    key: "duration",
    displayName: "时长",
    required: true,
    kind: "enum" as const,
    defaultValue: "4",
    options: ["4", "5"]
  }, {
    idx: "2",
    key: "mode",
    displayName: "清晰度",
    required: true,
    kind: "enum" as const,
    defaultValue: "720p",
    options: ["480p", "720p"]
  }],
  sceneCode: "t2v",
  modelCode: "code",
  spaceId: 1,
  uploadStrategy: "general" as const,
  modes: ["text-to-video" as const, "image-to-video" as const]
}];
const objects = new Map<string, Buffer>();
const store = {
  put: (key: string, stream: NodeJS.ReadableStream, options: { expectedSize: number }) => {
    objects.set(key, Buffer.from("abc"));
    return Promise.resolve({
      key,
      size: options.expectedSize,
      openRead: () => stream,
      remove: () => Promise.resolve()
    });
  },
  get: () => Promise.resolve(null),
  remove: () => Promise.resolve()
};
const quoteCalls: VideoQuoteInput[] = [];
const quoteParam = (
  input: VideoQuoteInput,
  key: string,
  fallback: string
): string => {
  const value = input.parameters[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : fallback;
};
const quote = {
  quote: (input: VideoQuoteInput) => {
    quoteCalls.push(input);
    return Promise.resolve({
      points: 92,
      priceQueryResult: {
        priceQueryRequest: {
          enablePriceQuery: true as const,
          priceQueryService: "sd2",
          params: {
            shortVender: "byte",
            shortSenceCode: input.mode === "image-to-video" ? "i2v" : "t2v",
            model_name: "sd2mini",
            duration: quoteParam(input, "duration", "4"),
            mode: quoteParam(input, "mode", "480p"),
            aspect_ratio: "16:9"
          }
        }
      }
    });
  }
};
const app = await createPostgresApiRuntime(
  graph,
  store,
  models,
  "admin",
  undefined,
  undefined,
  undefined,
  quote
);
const login = await app.inject({
  method: "POST",
  url: "/admin/api/login",
  payload: { password: "admin" }
});
const setCookie = login.headers["set-cookie"];
const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)
  ?.split(";")[0];
const csrf = login.json<{ csrf_token: string }>().csrf_token;
if (cookie === undefined) throw new Error("login failed");
const headers = { cookie, "x-csrf-token": csrf };
const listed = await app.inject({
  method: "GET",
  url: "/admin/api/playground/models?type=video&mode=text-to-video",
  headers
});
const listedModel = listed.json<{
  models: Array<{ display_name: string; parameters: unknown[] }>;
}>().models[0];
if (
  listedModel?.display_name !== "Fixture Video"
  || listedModel.parameters.length !== 2
) {
  throw new Error("playground models failed");
}
const quoted = await app.inject({
  method: "POST",
  url: "/admin/api/playground/quote",
  headers,
  payload: {
    kind: "video",
    model: "video",
    mode: "text-to-video",
    parameters: { duration: "4" }
  }
});
if (quoted.json<{ points: number }>().points !== 92) {
  throw new Error("playground quote failed");
}
const run = await app.inject({
  method: "POST",
  url: "/admin/api/playground/run",
  headers,
  payload: {
    kind: "video",
    model: "video",
    prompt: "hello",
    mode: "text-to-video",
    parameters: { duration: "4", mode: "480p" }
  }
});
const runJob = run.json<{ job: { id: string; status: string; quoted_points: number } }>().job;
if (run.statusCode !== 200 || runJob.status !== "queued" || runJob.quoted_points !== 92) {
  throw new Error("playground run failed");
}
const snapshot = await graph.snapshots.payload(runJob.id) as {
  priceQueryResult?: {
    priceQueryRequest?: { params?: Record<string, unknown> };
  };
};
if (snapshot.priceQueryResult?.priceQueryRequest?.params?.["model_name"] !== "sd2mini") {
  throw new Error("live price request was not persisted");
}
if (quoteCalls.length !== 2) throw new Error("live quote was not reused");
const i2v = await app.inject({
  method: "POST",
  url: "/admin/api/playground/run",
  headers,
  payload: {
    kind: "video",
    model: "video",
    prompt: "i2v",
    mode: "image-to-video",
    input_image: "data:image/png;base64,YWJj",
    parameters: { duration: "4" }
  }
});
if (i2v.statusCode !== 200) throw new Error("playground i2v failed");
await app.close();
const noQuoteApp = await createPostgresApiRuntime(
  graph,
  store,
  models,
  "admin"
);
const noQuoteLogin = await noQuoteApp.inject({
  method: "POST",
  url: "/admin/api/login",
  payload: { password: "admin" }
});
const noQuoteSetCookie = noQuoteLogin.headers["set-cookie"];
const noQuoteCookie = (
  Array.isArray(noQuoteSetCookie) ? noQuoteSetCookie[0] : noQuoteSetCookie
)?.split(";")[0];
if (noQuoteCookie === undefined) throw new Error("no-quote login failed");
const objectsBeforeNoQuote = objects.size;
const noQuoteRun = await noQuoteApp.inject({
  method: "POST",
  url: "/admin/api/playground/run",
  headers: {
    cookie: noQuoteCookie,
    "x-csrf-token": noQuoteLogin.json<{ csrf_token: string }>().csrf_token
  },
  payload: {
    kind: "video",
    model: "video",
    prompt: "must fail closed without storing the frame",
    mode: "image-to-video",
    input_image: "data:image/png;base64,YWJj",
    parameters: { duration: "4", mode: "480p" }
  }
});
if (noQuoteRun.statusCode < 500) {
  throw new Error("missing live quote did not fail closed");
}
if (objects.size !== objectsBeforeNoQuote) {
  throw new Error("quote failure persisted an unbound input object");
}
await noQuoteApp.close();
await graph.close();
console.log("postgres playground passed");
