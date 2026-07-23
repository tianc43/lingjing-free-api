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

const SECRET_NAMES = new Set([
  "authorization",
  "apikey",
  "cookie",
  "csrftoken",
  "ptkey",
  "ptpin",
  "lingjingapikey",
  "originpin",
  "storagestate",
  "taskid"
]);

function normalizeSecretName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function isSafeAtomicToken(value: string): boolean {
  const normalized = value
    .trim()
    .replace(/^Bearer\s+/iu, "")
    .replace(/^["'`]|["'`,;]$/gu, "");
  return normalized.length === 0
    || normalized.startsWith("fixture-")
    || normalized === "change-me"
    || normalized === "[REDACTED]"
    || /^\$\{[A-Za-z_][A-Za-z0-9_]*(?::-)?\}$/u.test(normalized)
    || /^\$env:[A-Z][A-Z0-9_]*$/u.test(normalized)
    || /^\$[A-Z][A-Z0-9_]*$/u.test(normalized);
}

function isSafeCookieHeader(value: string): boolean {
  if (isSafeAtomicToken(value)) return true;
  const normalized = value
    .trim()
    .replace(/^["'`]|["'`,;]$/gu, "");
  const cookieParts = normalized.split(";").map((part) => part.trim());
  return cookieParts.length > 0 && cookieParts.every((part) => {
    const separator = part.indexOf("=");
    return separator > 0 && isSafeAtomicToken(part.slice(separator + 1));
  });
}

function isSafeNamedValue(name: string, value: string): boolean {
  return normalizeSecretName(name) === "cookie"
    ? isSafeCookieHeader(value)
    : isSafeAtomicToken(value);
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
  if (Array.isArray(record.cookies)) {
    for (const [index, cookie] of record.cookies.entries()) {
      if (typeof cookie !== "object" || cookie === null) continue;
      const cookieValue = (cookie as Record<string, unknown>).value;
      if (
        typeof cookieValue === "string"
        && !isSafeAtomicToken(cookieValue)
      ) {
        violations.push(
          `${source}:${path}.cookies[${String(index)}].value contains non-fixture credential`
        );
      }
    }
  }
  const cookieName = typeof record.name === "string"
    ? normalizeSecretName(record.name)
    : "";
  if (
    SECRET_NAMES.has(cookieName)
    && typeof record.value === "string"
    && !isSafeAtomicToken(record.value)
  ) {
    violations.push(`${source}:${path}.value contains non-fixture credential`);
  }
  for (const [key, item] of Object.entries(record)) {
    const normalizedKey = normalizeSecretName(key);
    if (SECRET_NAMES.has(normalizedKey) && (
      typeof item === "string" || typeof item === "number"
    ) && !isSafeNamedValue(key, String(item))) {
      violations.push(`${source}:${path}.${key} contains non-fixture credential`);
    }
    walkJson(item, source, `${path}.${key}`, violations);
  }
}

function scanText(input: SecurityInput, violations: string[]): void {
  const cookieAssignments =
    /\b(?:pt[_-]?key|pt[_-]?pin|csrf[_-]?token)=([^;\s"'`]+)/giu;
  for (const match of input.content.matchAll(cookieAssignments)) {
    const value = match[1];
    if (value !== undefined && !isSafeAtomicToken(value)) {
      violations.push(
        `${input.name} contains non-fixture cookie credential`
      );
    }
  }
  const bearer = /\bAuthorization:\s*Bearer\s+([^\s"'`]+)/giu;
  for (const match of input.content.matchAll(bearer)) {
    const value = match[1];
    if (value !== undefined && !isSafeAtomicToken(value)) {
      violations.push(
        `${input.name} contains non-fixture bearer credential`
      );
    }
  }
  const quotedAssignments =
    /\b(origin[_-]?pin|task[_-]?id|cookie|csrf[_-]?token|pt[_-]?key|pt[_-]?pin|authorization|(?:lingjing[_-]?)?api[_-]?key|storage[_-]?state)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|`([^`\r\n]*)`)/giu;
  for (const match of input.content.matchAll(quotedAssignments)) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    if (
      name !== undefined
      && value !== undefined
      && !isSafeNamedValue(name, value)
    ) {
      violations.push(
        `${input.name} contains non-fixture sensitive assignment`
      );
    }
  }
  if (/\.(?:env|ya?ml|md|txt|log)$/iu.test(input.name)) {
    const bareAssignments =
      /^\s*(?:-\s*)?(origin[_-]?pin|task[_-]?id|cookie|csrf[_-]?token|pt[_-]?key|pt[_-]?pin|(?:lingjing[_-]?)?api[_-]?key|storage[_-]?state)\s*[:=]\s*([^\s#,\]]+)/gimu;
    for (const match of input.content.matchAll(bareAssignments)) {
      const name = match[1];
      const value = match[2];
      if (
        name !== undefined
        && value !== undefined
        && !isSafeNamedValue(name, value)
      ) {
        violations.push(
          `${input.name} contains non-fixture sensitive assignment`
        );
      }
    }
    const bareAuthorization =
      /^\s*(?:-\s*)?authorization\s*[:=]\s*(?:Bearer\s+)?([^\s#,\]]+)/gimu;
    for (const match of input.content.matchAll(bareAuthorization)) {
      const value = match[1];
      if (value !== undefined && !isSafeAtomicToken(value)) {
        violations.push(
          `${input.name} contains non-fixture sensitive assignment`
        );
      }
    }
  }
  const jdMediaUrl =
    /\bhttps?:\/\/(?:[a-z0-9-]+\.)?(?:360buyimg\.com|jcloudcs\.com|jdcdn\.com|jdcloud-oss\.com)\/[^\s"'<>)]*/giu;
  if (jdMediaUrl.test(input.content)) {
    violations.push(`${input.name} contains a JD media URL`);
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
  const npm = npmCommand();
  execFileSync(
    npm.executable,
    [...npm.prefix, "run", "build", "--silent"],
    { cwd: projectRoot, encoding: "utf8" }
  );
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
