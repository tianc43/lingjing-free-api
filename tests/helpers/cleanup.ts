import { rmSync, type RmOptions } from "node:fs";

type RemoveDirectory = (
  path: string,
  options: RmOptions
) => void;

const CLEANUP_OPTIONS: RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 20
};

export function removeTestDirectory(
  path: string,
  remove: RemoveDirectory = rmSync
): void {
  remove(path, CLEANUP_OPTIONS);
}
