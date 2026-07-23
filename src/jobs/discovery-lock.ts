export class DiscoveryLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
