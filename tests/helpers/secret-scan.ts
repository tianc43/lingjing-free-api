import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

export interface SecurityInput {
  name: string;
  content: string;
}

const SAFE_TOKEN_PREFIXES = [
  "fixture-",
  "change-me",
  "${",
  "$env:",
  "$LINGJING_"
];
const SECRET_NAMES = new Set([
  "authorization",
  "cookie",
  "csrftoken",
  "pt_key",
  "pt_pin",
  "lingjing_api_key",
  "originpin",
  "taskid"
]);

function isSafeToken(value: string): boolean {
  const normalized = value.trim().replace(/^Bearer\s+/iu, "");
  return normalized.length === 0
    || SAFE_TOKEN_PREFIXES.some((prefix) =>
      normalized.toLowerCase().startsWith(prefix.toLowerCase())
    );
}

function walkJson(
  value: unknown,
  source: string,
  path: string,
  violations: string[]
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walkJson(item, source, `${path}[${String(index)}]`, violations);
    }
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const cookieName = typeof record.name === "string"
    ? record.name.toLowerCase()
    : "";
  if (
    SECRET_NAMES.has(cookieName)
    && typeof record.value === "string"
    && !isSafeToken(record.value)
  ) {
    violations.push(`${source}:${path}.value contains non-fixture credential`);
  }
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = key.toLowerCase();
    if (
      SECRET_NAMES.has(normalizedKey)
      && typeof item === "string"
      && !isSafeToken(item)
    ) {
      violations.push(`${source}:${path}.${key} contains non-fixture credential`);
    }
    walkJson(item, source, `${path}.${key}`, violations);
  }
}

function scanText(input: SecurityInput, violations: string[]): void {
  const cookieAssignments =
    /\b(?:pt_key|pt_pin|csrfToken)=([^;\s"'`]+)/giu;
  for (const match of input.content.matchAll(cookieAssignments)) {
    const value = match[1];
    if (value !== undefined && !isSafeToken(value)) {
      violations.push(
        `${input.name} contains non-fixture cookie credential`
      );
    }
  }
  const bearer = /\bAuthorization:\s*Bearer\s+([^\s"'`]+)/giu;
  for (const match of input.content.matchAll(bearer)) {
    const value = match[1];
    if (value !== undefined && !isSafeToken(value)) {
      violations.push(
        `${input.name} contains non-fixture bearer credential`
      );
    }
  }
  const downstreamKey =
    /\bLINGJING_API_KEY\s*[:=]\s*["']?([A-Za-z0-9_-]{16,})/gu;
  for (const match of input.content.matchAll(downstreamKey)) {
    const value = match[1];
    if (value !== undefined && !isSafeToken(value)) {
      violations.push(
        `${input.name} contains non-fixture downstream API key`
      );
    }
  }
  try {
    const parsed = JSON.parse(input.content) as unknown;
    const topLevel = typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
    const securityShaped = input.name.endsWith(".log")
      || topLevel !== null && (
        "cookies" in topLevel
        || "origins" in topLevel
        || Object.keys(topLevel).some((key) =>
          SECRET_NAMES.has(key.toLowerCase())
        )
      );
    if (securityShaped) {
      walkJson(parsed, input.name, "$", violations);
    }
  } catch {
    // Most tracked files are source or documentation rather than JSON.
  }
}

export function scanSecrets(inputs: readonly SecurityInput[]): string[] {
  const violations: string[] = [];
  for (const input of inputs) scanText(input, violations);
  return [...new Set(violations)];
}

export function assertNoSensitiveValues(
  content: string,
  sensitiveValues: readonly string[]
): void {
  const leaked = sensitiveValues.filter((value) =>
    value.length > 0 && content.includes(value)
  );
  if (leaked.length > 0) {
    throw new Error(
      `Captured output contains ${String(leaked.length)} sensitive value(s)`
    );
  }
}

function recursiveFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) files.push(...recursiveFiles(path));
    else if (stats.isFile()) files.push(path);
  }
  return files;
}

function npmCommand(): { executable: string; prefix: string[] } {
  const environmentCli = process.env.npm_execpath;
  if (environmentCli !== undefined && existsSync(environmentCli)) {
    return {
      executable: process.execPath,
      prefix: [environmentCli]
    };
  }
  const adjacentCli = resolve(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (existsSync(adjacentCli)) {
    return {
      executable: process.execPath,
      prefix: [adjacentCli]
    };
  }
  return { executable: "npm", prefix: [] };
}

export function collectProjectSecurityInputs(
  projectRoot: string,
  captured: readonly SecurityInput[] = []
): SecurityInput[] {
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--", "."],
    { cwd: projectRoot, encoding: "utf8" }
  ).split("\0").filter((value) => value.length > 0);
  const inputs: SecurityInput[] = tracked.map((path) => ({
    name: `git:${path}`,
    content: readFileSync(resolve(projectRoot, path), "utf8")
  }));
  for (const path of recursiveFiles(resolve(projectRoot, "dist"))) {
    inputs.push({
      name: `dist:${relative(resolve(projectRoot, "dist"), path)}`,
      content: readFileSync(path, "utf8")
    });
  }
  const npm = npmCommand();
  const packageDryRun = execFileSync(
    npm.executable,
    [...npm.prefix, "pack", "--dry-run", "--json"],
    { cwd: projectRoot, encoding: "utf8" }
  );
  const packageManifest = JSON.parse(packageDryRun) as Array<{
    files?: Array<{ path?: string }>;
  }>;
  const forbiddenPackagePath =
    /(?:^|\/)(?:\.env(?:\.|$)|data|tests?|storage-state|playwright-report|test-results)(?:\/|$)|\.(?:sqlite|db)$|\.(?:mp4|mov|avi|webm)$/iu;
  for (const file of packageManifest.flatMap((entry) => entry.files ?? [])) {
    if (
      typeof file.path === "string"
      && forbiddenPackagePath.test(file.path.replaceAll("\\", "/"))
    ) {
      throw new Error(`npm package contains forbidden path: ${file.path}`);
    }
  }
  inputs.push({
    name: "npm-pack-dry-run.json",
    content: packageDryRun
  });
  inputs.push(...captured);
  return inputs;
}
