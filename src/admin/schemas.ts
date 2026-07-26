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

export const createApiKeyBodySchema = z.object({
  name: z.string().trim().min(1).max(200)
}).strict();

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
  error_code: z.string().nullable()
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

export const apiKeyViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  key_prefix: z.string(),
  enabled: z.boolean(),
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

export const settingsResponseSchema = z.object({
  max_concurrency: nonNegativeInteger,
  max_queued_requests: nonNegativeInteger,
  unknown_capacity_hold_ms: nonNegativeInteger,
  image_wait_timeout_ms: nonNegativeInteger,
  video_wait_timeout_ms: nonNegativeInteger,
  docs_enabled: z.boolean(),
  shared_api_key_configured: z.boolean(),
  legacy_api_key_configured: z.boolean(),
  api_base_url: z.string()
}).strict();
