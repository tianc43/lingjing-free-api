import { afterEach } from "vitest";
import { copyFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeTestDirectory } from "./cleanup.js";

const temporaryDirectories: string[] = [];
const fixturesDirectory = new URL("../unit/fixtures/", import.meta.url);

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    removeTestDirectory(directory);
  }
});

export async function copyFixtureToTemporaryFile(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "lingjing-session-"));
  temporaryDirectories.push(directory);
  const source = new URL(name, fixturesDirectory);
  const destination = join(directory, basename(name));
  await copyFile(source, destination);
  return destination;
}

export async function readValidStorageState(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

export async function readFakeCsrfFromStorageState(path: string): Promise<string | undefined> {
  const state = await readValidStorageState(path) as {
    cookies: Array<{ name: string; value: string }>;
  };
  return state.cookies.find((cookie) => cookie.name === "csrfToken")?.value;
}

export function failingAtomicWriter(): Promise<void> {
  return Promise.reject(new Error("fixture atomic write failure"));
}
