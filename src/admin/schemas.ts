import { z } from "zod";

const nonNegativeInteger = z.number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const loginBodySchema = z.object({
  password: z.string()
}).strict();

export const accountParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const jobParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const createAccountBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  priority: nonNegativeInteger,
  daily_point_limit: nonNegativeInteger,
  monthly_point_limit: nonNegativeInteger
}).strict();

export const importAccountBodySchema = createAccountBodySchema.extend({
  cookie_format: z.enum(["header", "json"]),
  cookie_input: z.string().min(1).max(65_536)
}).strict();

export const identityParamsSchema = z.object({ id: z.string().min(1) }).strict();
export const createUserBodySchema = z.object({
  name: z.string().trim().min(1).max(200)
}).strict();
export const createProjectBodySchema = z.object({
  user_id: z.string().min(1),
  name: z.string().trim().min(1).max(200)
}).strict();
export const setIdentityStatusBodySchema = z.object({
  status: z.enum(["active", "disabled"])
}).strict();

export const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(200),
  user_id: z.string().min(1).optional(),
  project_id: z.string().min(1).optional(),
  scopes: z.array(z.enum([
    "models:read", "video:create", "video:read", "image:create", "image:read"
  ])).min(1).optional(),
  expires_at: z.number().int().positive().nullable().optional()
}).strict().refine(
  (value) => (value.user_id === undefined) === (value.project_id === undefined),
  "user_id and project_id must be provided together"
);

export const apiKeyParamsSchema = z.object({
  id: z.string().min(1)
}).strict();

export const updateAccountBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  priority: nonNegativeInteger.optional(),
  daily_point_limit: nonNegativeInteger.optional(),
  monthly_point_limit: nonNegativeInteger.optional()
}).strict().refine(
  (value) => Object.keys(value).length > 0,
  "At least one account field is required"
);

export const resolveUnknownBodySchema = z.object({
  job_id: z.string().min(1),
  action: z.enum(["charge", "release"])
}).strict();

export const playgroundModelsQuerySchema = z.object({
  type: z.enum(["image", "video"]).default("image"),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  refresh: z.enum(["true", "false"]).optional().transform(
    (value) => value === "true"
  )
}).strict().superRefine((query, context) => {
  if (query.type !== "video" && query.mode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Image models do not accept a video mode"
    });
  }
});

export const playgroundRunBodySchema = z.object({
  kind: z.enum(["image", "video"]),
  model: z.string().min(1),
  prompt: z.string().trim().min(1).max(8_000),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  input_image: z.string().max(28_000_000).optional(),
  parameters: z.record(z.string(), z.unknown()).default({})
}).strict().superRefine((body, context) => {
  if (body.kind === "video" && body.mode === undefined) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Video mode is required"
    });
  }
  if (body.kind === "image" && body.mode !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["mode"],
      message: "Image requests do not accept a video mode"
    });
  }
  if (body.mode === "image-to-video" && body.input_image === undefined) {
    context.addIssue({ code:"custom",path:["input_image"],message:"Image-to-video requires an input image" });
  }
});

export const jobListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum([
    "queued",
    "submitting",
    "discovering",
    "processing",
    "unknown",
    "completed",
    "failed"
  ]).optional()
}).strict();

export const accountViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  priority: nonNegativeInteger,
  daily_point_limit: nonNegativeInteger,
  monthly_point_limit: nonNegativeInteger,
  daily_used_points: nonNegativeInteger,
  monthly_used_points: nonNegativeInteger,
  daily_reserved_points: nonNegativeInteger,
  monthly_reserved_points: nonNegativeInteger,
  health_status: z.enum([
    "unknown",
    "ready",
    "needs_login",
    "unhealthy"
  ]),
  last_error_code: z.string().nullable(),
  has_session: z.boolean(),
  subject_hash: z.string().nullable(),
  membership: z.string().nullable(),
  points_balance: z.number().nullable(),
  total_balance: z.number().nullable(),
  max_concurrency: nonNegativeInteger.nullable(),
  active_jobs: nonNegativeInteger,
  last_checked_at: z.number().nullable(),
  updated_at: z.number()
}).strict();

export const adminJobViewSchema = z.object({
  id: z.string(),
  account_name: z.string(),
  kind: z.enum(["image", "video"]),
  model: z.string(),
  status: z.enum([
    "queued",
    "submitting",
    "discovering",
    "processing",
    "unknown",
    "completed",
    "failed"
  ]),
  quoted_points: z.number().nonnegative().nullable(),
  budget_state: z.enum(["reserved", "charged", "released"]).nullable(),
  submitted_at: z.number().nullable(),
  discovered_at: z.number().nullable(),
  completed_at: z.number().nullable(),
  failed_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  error_code: z.string().nullable(),
  outputs: z.array(z.object({url:z.string(),poster_url:z.string().nullable(),width:z.number().nullable(),height:z.number().nullable(),duration:z.number().nullable(),format:z.string().nullable()}).strict())
}).strict();

export const loginResponseSchema = z.object({
  authenticated: z.literal(true),
  csrf_token: z.string(),
  expires_at: z.number()
}).strict();

export const sessionResponseSchema = loginResponseSchema;

export const accountResponseSchema = z.object({
  account: accountViewSchema
}).strict();

export const createAccountResponseSchema = accountResponseSchema.extend({
  login_command: z.string()
}).strict();

export const accountListResponseSchema = z.object({
  accounts: z.array(accountViewSchema)
}).strict();

export const userViewSchema = z.object({
  id: z.string(), name: z.string(), status: z.enum(["active", "disabled"]),
  created_at: z.number(), updated_at: z.number()
}).strict();
export const projectViewSchema = z.object({
  id: z.string(), user_id: z.string(), name: z.string(),
  status: z.enum(["active", "disabled"]), created_at: z.number(), updated_at: z.number()
}).strict();
export const userListResponseSchema = z.object({ users: z.array(userViewSchema) }).strict();
export const projectListResponseSchema = z.object({ projects: z.array(projectViewSchema) }).strict();
export const userResponseSchema = z.object({ user: userViewSchema }).strict();
export const projectResponseSchema = z.object({ project: projectViewSchema }).strict();

export const apiKeyViewSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  project_id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  scopes: z.array(z.enum([
    "models:read", "video:create", "video:read", "image:create", "image:read"
  ])),
  enabled: z.boolean(),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  last_used_at: z.number().nullable(),
  revoked_at: z.number().nullable()
}).strict();

export const apiKeyResponseSchema = z.object({
  key: apiKeyViewSchema
}).strict();

export const createApiKeyResponseSchema = apiKeyResponseSchema.extend({
  api_key: z.string()
}).strict();

export const apiKeyListResponseSchema = z.object({
  api_keys: z.array(apiKeyViewSchema)
}).strict();

export const jobResponseSchema = z.object({
  job: adminJobViewSchema
}).strict();

export const jobListResponseSchema = z.object({
  jobs: z.array(adminJobViewSchema)
}).strict();

const playgroundParameterSchema = z.object({
  key: z.string(),
  display_name: z.string(),
  required: z.boolean(),
  type: z.enum(["string", "number", "boolean", "enum", "image-list"]),
  default: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  options: z.array(z.string()).optional(),
  max_files: z.number().optional()
}).strict();

export const playgroundModelSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  type: z.enum(["image", "video"]),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  capabilities: z.object({
    text: z.boolean(),
    input_images: z.boolean()
  }).strict(),
  parameters: z.array(playgroundParameterSchema),
  pricing: z.unknown().nullable()
}).strict();

export const playgroundModelsResponseSchema = z.object({
  models: z.array(playgroundModelSchema)
}).strict();

export const playgroundRunResponseSchema = z.object({
  job: adminJobViewSchema
}).strict();

export const overviewResponseSchema = z.object({
  accounts: z.object({
    total: nonNegativeInteger,
    enabled: nonNegativeInteger,
    ready: nonNegativeInteger,
    unhealthy: nonNegativeInteger,
    budget_exhausted: nonNegativeInteger
  }).strict(),
  usage: z.object({
    daily_used_points: nonNegativeInteger,
    monthly_used_points: nonNegativeInteger,
    daily_reserved_points: nonNegativeInteger,
    monthly_reserved_points: nonNegativeInteger
  }).strict(),
  jobs: z.object({
    active: nonNegativeInteger,
    queued: nonNegativeInteger
  }).strict(),
  balance: z.object({
    available_points: z.number().nonnegative()
  }).strict(),
  recent_failures: z.array(adminJobViewSchema)
}).strict();

export const configureWebhookBodySchema=z.object({project_id:z.string(),url:z.url()}).strict();
export const webhookStatusBodySchema=z.object({enabled:z.boolean()}).strict();
export const webhookViewSchema=z.object({id:z.string(),project_id:z.string(),url:z.string(),secret:z.string(),enabled:z.boolean()}).strict();
export const webhookResponseSchema=z.object({webhook:webhookViewSchema}).strict();
export const webhookDeliverySchema=z.object({id:z.string(),project_id:z.string(),job_id:z.string(),event_type:z.string(),status:z.enum(["pending","delivered","dead"]),attempts:z.number(),next_attempt_at:z.number(),last_error:z.string().nullable(),delivered_at:z.number().nullable(),created_at:z.number()}).strict();
export const webhookDeliveryListSchema=z.object({deliveries:z.array(webhookDeliverySchema)}).strict();
export const webhookListResponseSchema=z.object({webhooks:z.array(webhookViewSchema)}).strict();

export const createPlanBodySchema = z.object({
  name:z.string().trim().min(1).max(200), enabled:z.boolean().default(true),
  allowed_modes:z.array(z.enum(["text-to-video","image-to-video"])).min(1),
  allowed_models:z.array(z.string()).default([]), max_duration_seconds:z.number().int().nonnegative(),
  allowed_resolutions:z.array(z.string()).default([]), daily_limit_points:z.number().nonnegative().default(0), monthly_limit_points:z.number().nonnegative().default(0), max_concurrency:z.number().int().nonnegative().default(0), max_queued_requests:z.number().int().nonnegative().default(0)
}).strict();
export const assignPlanBodySchema = z.object({ project_id:z.string(), plan_id:z.string() }).strict();
export const planViewSchema = z.object({ id:z.string(),name:z.string(),enabled:z.boolean(),allowed_modes:z.array(z.string()),allowed_models:z.array(z.string()),max_duration_seconds:z.number(),allowed_resolutions:z.array(z.string()),daily_limit_points:z.number(),monthly_limit_points:z.number(),max_concurrency:z.number(),max_queued_requests:z.number(),created_at:z.number(),updated_at:z.number() }).strict();
export const planResponseSchema = z.object({plan:planViewSchema}).strict();
export const planListResponseSchema = z.object({plans:z.array(planViewSchema)}).strict();

export const usageQuerySchema = z.object({
  user_id: z.string().optional(), project_id: z.string().optional(),
  api_key_id: z.string().optional(), account_id: z.string().optional(),
  from: z.coerce.number().optional(), to: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100)
}).strict();
export const usageEntrySchema = z.object({
  id:z.string(), job_id:z.string(), user_id:z.string(), project_id:z.string(),
  api_key_id:z.string().nullable(), account_id:z.string(),
  type:z.enum(["hold","charge","release","refund","adjustment"]),
  points:z.number(), reason:z.string(), created_at:z.number()
}).strict();
export const usageResponseSchema = z.object({
  summary:z.object({ held_points:z.number(), charged_points:z.number(), released_points:z.number(), refunded_points:z.number(), adjusted_points:z.number(), net_points:z.number(), entry_count:z.number() }).strict(),
  entries:z.array(usageEntrySchema)
}).strict();

export const settingsResponseSchema = z.object({
  max_concurrency: nonNegativeInteger,
  max_queued_requests: nonNegativeInteger,
  unknown_capacity_hold_ms: nonNegativeInteger,
  image_wait_timeout_ms: nonNegativeInteger,
  video_wait_timeout_ms: nonNegativeInteger,
  docs_enabled: z.boolean(),
  shared_api_key_configured: z.boolean(),
  legacy_api_key_configured: z.boolean(),
  api_base_url: z.string(),
  output_retention_ms:z.number()
}).strict();
