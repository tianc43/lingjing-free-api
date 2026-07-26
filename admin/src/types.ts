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

export interface Job {
  id: string;
  account_name: string;
  kind: string;
  model: string;
  status: string;
  quoted_points: number | null;
  budget_state: string | null;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}

export interface Overview {
  accounts: { total: number; enabled: number; ready: number; unhealthy: number; budget_exhausted: number };
  usage: { daily_used_points: number; monthly_used_points: number; daily_reserved_points: number; monthly_reserved_points: number };
  jobs: { active: number; queued: number };
  balance: { available_points: number };
  recent_failures: Job[];
}

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
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  enabled: boolean;
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
