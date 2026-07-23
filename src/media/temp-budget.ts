import { errors } from "../errors.js";
import type { TempBudget, TempBudgetLease } from "./types.js";

function validByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function createTempBudget(maxBytes: number): TempBudget {
  if (!validByteCount(maxBytes)) {
    throw new TypeError("Temporary storage limit must be a non-negative safe integer");
  }

  let used = 0;

  return {
    reserve(initialBytes: number): TempBudgetLease {
      if (!validByteCount(initialBytes)) {
        throw new TypeError("Temporary storage reservation must be a non-negative safe integer");
      }
      if (initialBytes > maxBytes - used) {
        throw errors.temporaryStorageExhausted();
      }

      used += initialBytes;
      let leased = initialBytes;
      let released = false;

      return {
        growTo(bytes: number): void {
          if (!validByteCount(bytes)) {
            throw new TypeError("Temporary storage reservation must be a non-negative safe integer");
          }
          if (released) {
            throw new Error("Temporary storage lease has already been released");
          }
          const delta = bytes - leased;
          if (delta > maxBytes - used) {
            throw errors.temporaryStorageExhausted();
          }
          used += delta;
          leased = bytes;
        },
        release(): void {
          if (released) return;
          released = true;
          used -= leased;
          leased = 0;
        }
      };
    },
    usedBytes(): number {
      return used;
    }
  };
}
