import type { LingjingTransport } from "./types.js";

const PROGRESS_PATH = "/local/activity/signInProgress";
const COMPLETE_PATH = "/joycreator/activity/task_complete";
const ACTIVITY_PATTERN = /^ACT[A-Za-z0-9]+$/u;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60_000;

type RecordValue = Record<string, unknown>;

export interface SignInResult {
  status: "signed" | "already_signed" | "no_active_activity" | "unknown";
  currentFrequency: number | null;
}

interface SignInProgress {
  activityNo: string;
  currentFrequency: number | null;
  updateDate: string | null;
}

type ProgressState =
  | { kind: "none" }
  | { kind: "malformed" }
  | { kind: "active"; value: SignInProgress };

function record(value: unknown): RecordValue | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function statusNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string" || !/^-?\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function platformDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/u
    .exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    return null;
  }
  return value.slice(0, 10);
}

function shanghaiDate(now: number): string {
  return new Date(now + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function progress(value: unknown): ProgressState {
  if (!Array.isArray(value)) return { kind: "malformed" };
  if (value.length === 0) return { kind: "none" };
  for (const item of value) {
    const row = record(item);
    if (row === null) return { kind: "malformed" };
    const status = statusNumber(row.status);
    if (status === null) return { kind: "malformed" };
    if (status !== 1) continue;
    const activityNo = typeof row.activityNo === "string"
      ? row.activityNo
      : "";
    if (!ACTIVITY_PATTERN.test(activityNo)) return { kind: "malformed" };
    const updateTime = typeof row.updateTime === "string"
      ? row.updateTime
      : typeof row.lastUpdateDate === "string"
        ? row.lastUpdateDate
        : "";
    const updateDate = platformDate(updateTime);
    if (updateDate === null) {
      return { kind: "malformed" };
    }
    return {
      kind: "active",
      value: {
        activityNo,
        currentFrequency: typeof row.currentFrequency === "number"
          && Number.isFinite(row.currentFrequency)
          ? row.currentFrequency
          : null,
        updateDate
      }
    };
  }
  return { kind: "none" };
}

export class LingjingSignInService {
  constructor(
    private readonly transport: Pick<LingjingTransport, "read" | "submitOnce">,
    private readonly claimAttempt?: (
      activityNo: string,
      shanghaiDate: string
    ) => Promise<boolean>
  ) {}

  async signIn(now = Date.now()): Promise<SignInResult> {
    const today = shanghaiDate(now);
    const beforeState = await this.readProgress();
    if (beforeState.kind === "malformed") {
      throw new Error("Lingjing sign-in progress response is malformed");
    }
    if (beforeState.kind === "none") {
      return { status: "no_active_activity", currentFrequency: null };
    }
    const before = beforeState.value;
    if (before.updateDate === today) {
      return {
        status: "already_signed",
        currentFrequency: before.currentFrequency
      };
    }
    if (
      this.claimAttempt !== undefined
      && !await this.claimAttempt(before.activityNo, today)
    ) {
      return {
        status: "unknown",
        currentFrequency: before.currentFrequency
      };
    }

    let submitError: unknown;
    try {
      await this.transport.submitOnce<unknown>(COMPLETE_PATH, {
        activityNo: before.activityNo
      });
    } catch (cause) {
      submitError = cause;
    }
    const afterState = await this.readProgress();
    if (afterState.kind === "malformed") {
      throw new Error("Lingjing sign-in progress response is malformed");
    }
    const after = afterState.kind === "active" ? afterState.value : null;
    if (
      after?.activityNo === before.activityNo
      && after.updateDate === today
    ) {
      return {
        status: "signed",
        currentFrequency: after.currentFrequency
      };
    }
    if (submitError instanceof Error) throw submitError;
    if (submitError !== undefined) {
      throw new Error("Lingjing sign-in submission failed");
    }
    return {
      status: "unknown",
      currentFrequency: after?.currentFrequency ?? before.currentFrequency
    };
  }

  private async readProgress(): Promise<ProgressState> {
    return progress(await this.transport.read<unknown>(PROGRESS_PATH));
  }
}
