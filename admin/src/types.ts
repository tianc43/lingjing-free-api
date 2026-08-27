export type HealthStatus = "ready" | "needs_login" | "unhealthy" | "unknown";

export interface Account {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  daily_point_limit: number;
  monthly_point_limit: number;
  daily_used_points: number;
  monthly_used_points: number;
  daily_reserved_points: number;
  monthly_reserved_points: number;
  health_status: HealthStatus;
  last_error_code: string | null;
  has_session: boolean;
  membership: string | null;
  points_balance: number | null;
  total_balance: number | null;
  active_jobs: number;
  last_checked_at: number | null;
  updated_at: number;
}

export interface BrowserLogin {id:string;account_id:string;status:"running"|"completed"|"failed";error:string|null;}

export interface Job {
  id: string;
  account_name: string;
  kind: "image" | "video";
  model: string;
  status: string;
  quoted_points: number | null;
  budget_state: string | null;
  submitted_at?: number | null;
  discovered_at?: number | null;
  completed_at?: number | null;
  failed_at?: number | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
  outputs: Array<{url:string;poster_url:string|null;width:number|null;height:number|null;duration:number|null;format:string|null}>;
}

export interface PlaygroundParameter {
  key: string;
  display_name: string;
  required: boolean;
  type: "string" | "number" | "boolean" | "enum" | "image-list";
  default?: unknown;
  minimum?: number;
  maximum?: number;
  options?: string[];
}

export interface PlaygroundModel {
  id: string;
  display_name: string;
  type: "image" | "video";
  mode?: "text-to-video" | "image-to-video";
  capabilities: { text: boolean; input_images: boolean };
  parameters: PlaygroundParameter[];
  pricing: unknown;
}

export interface PlaygroundInput {
  kind: "image" | "video";
  model: string;
  prompt: string;
  mode?: "text-to-video" | "image-to-video";
  input_image?: string;
  parameters: Record<string, unknown>;
}

export type AccountSignInStatus = "checking" | "signed" | "already_signed"
  | "no_active_activity" | "unknown" | "failed";

export interface SignInStatus {
  enabled: boolean;
  interval_ms: number;
  running: boolean;
  next_check_at: number | null;
  last_run_started_at: number | null;
  last_run_finished_at: number | null;
  accounts: Array<{
    account_id: string;
    status: AccountSignInStatus;
    current_frequency: number | null;
    checked_at: number;
  }>;
}

export interface PlaygroundQuoteInput {
  kind: "video";
  model: string;
  mode: "text-to-video" | "image-to-video";
  parameters: Record<string, unknown>;
}

export interface PlaygroundQuote {
  points: number;
  source: "live";
}

export interface Overview {
  accounts: { total: number; enabled: number; ready: number; unhealthy: number; budget_exhausted: number };
  usage: { daily_used_points: number; monthly_used_points: number; daily_reserved_points: number; monthly_reserved_points: number };
  jobs: { active: number; queued: number };
  balance: { available_points: number };
  recent_failures: Job[];
}

export interface WebhookDelivery {id:string;project_id:string;job_id:string;event_type:string;status:"pending"|"delivered"|"dead";attempts:number;next_attempt_at:number;last_error:string|null;delivered_at:number|null;created_at:number;}
export interface WebhookEndpoint { id:string; project_id:string; url:string; secret:string; enabled:boolean; }
export interface UsageEntry { id:string; job_id:string; user_id:string; project_id:string; api_key_id:string|null; account_id:string; type:"hold"|"charge"|"release"|"refund"|"adjustment"; points:number; reason:string; created_at:number; }
export interface UsageData { summary:{ held_points:number; charged_points:number; released_points:number; refunded_points:number; adjusted_points:number; net_points:number; entry_count:number }; entries:UsageEntry[]; }

export interface Settings {
  shared_api_key_configured: boolean;
  max_concurrency: number;
  max_queued_requests: number;
  unknown_capacity_hold_ms: number;
  image_wait_timeout_ms: number;
  video_wait_timeout_ms: number;
  docs_enabled: boolean;
  legacy_api_key_configured: boolean;
  api_base_url: string;
  output_retention_ms:number;
}

export interface Plan { id:string; name:string; enabled:boolean; allowed_modes:("text-to-video"|"image-to-video")[]; allowed_models:string[]; max_duration_seconds:number; allowed_resolutions:string[]; daily_limit_points:number; monthly_limit_points:number; max_concurrency:number; max_queued_requests:number; created_at:number; updated_at:number; }

export interface User {
  id: string;
  name: string;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
}

export type ApiKeyScope = "models:read" | "video:create" | "video:read" | "image:create" | "image:read";

export interface ApiKey {
  id: string;
  user_id: string;
  project_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiKeyScope[];
  enabled: boolean;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface AccountInput {
  name: string;
  priority: number;
  daily_point_limit: number;
  monthly_point_limit: number;
}

export interface AccountImportInput extends AccountInput {
  cookie_format: "header" | "json";
  cookie_input: string;
}
