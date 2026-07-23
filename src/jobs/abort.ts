function abortReason(signal: AbortSignal, message: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(message);
}

export function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message: string
): Promise<T> {
  if (signal === undefined) return operation;
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(abortReason(signal, message));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal, message));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}
