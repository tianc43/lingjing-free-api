import type { Writable } from "node:stream";

export class SseWriter {
  private sentDone = false;

  constructor(private readonly output: Writable) {}

  async event(value: unknown, event?: string): Promise<void> {
    const frame = (event === undefined ? "" : `event: ${event}\n`)
      + `data: ${JSON.stringify(value)}\n\n`;
    await this.write(frame);
  }

  async done(): Promise<void> {
    if (this.sentDone) return;
    this.sentDone = true;
    await this.write("data: [DONE]\n\n");
  }

  private async write(value: string): Promise<void> {
    if (this.output.destroyed) {
      throw new Error("SSE client disconnected");
    }
    if (this.output.write(value)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        this.output.removeListener("drain", onDrain);
        this.output.removeListener("close", onClose);
        this.output.removeListener("error", onError);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        reject(new Error("SSE client disconnected"));
      };
      const onError = (cause: Error): void => {
        cleanup();
        reject(cause);
      };
      this.output.once("drain", onDrain);
      this.output.once("close", onClose);
      this.output.once("error", onError);
    });
  }
}
