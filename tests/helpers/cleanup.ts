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

const EXPECTED_WAL_CONTENTION_CLOSE =
  /^WAL checkpoint incomplete after 4 bounded attempts \((?:busy=\d+, log=\d+, checkpointed=\d+|SQLite remained busy or returned an invalid result)\); repository was closed safely$/u;

export function isExpectedWalContentionCloseError(
  cause: unknown
): cause is Error {
  return cause instanceof Error
    && EXPECTED_WAL_CONTENTION_CLOSE.test(cause.message);
}

export function removeTestDirectory(
  path: string,
  remove: RemoveDirectory = rmSync
): void {
  remove(path, CLEANUP_OPTIONS);
}
