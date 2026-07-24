import type { HealthStatus } from "../types";

const labels: Record<HealthStatus, string> = {
  ready: "Ready",
  needs_login: "Needs login",
  unhealthy: "Unhealthy",
  unknown: "Unknown"
};

export function StatusPill({ status }: { status: HealthStatus }) {
  return <span className={`status-pill status-${status}`}><span aria-hidden="true">●</span>{labels[status]}</span>;
}
