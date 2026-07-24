import type { BudgetWindow } from "./types.js";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;

function shanghaiDateParts(now: number): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "numeric",
    day: "numeric"
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day)
  };
}

export function budgetWindows(now = Date.now()): BudgetWindow {
  if (!Number.isFinite(now)) {
    throw new TypeError("Budget window time must be finite");
  }
  const { year, month, day } = shanghaiDateParts(now);
  return {
    dayWindowStart: Date.UTC(year, month - 1, day) - SHANGHAI_OFFSET_MS,
    monthWindowStart: Date.UTC(year, month - 1, 1) - SHANGHAI_OFFSET_MS
  };
}

export function countsTowardBudget(state: "reserved" | "charged" | "released"): boolean {
  return state !== "released";
}
