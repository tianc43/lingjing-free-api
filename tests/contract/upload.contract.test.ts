import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type {
  PreparedMedia,
  UploadedMaterial
} from "../../src/media/types.js";
import type {
  SignedUploadResponse,
  UploadRequest
} from "../../src/lingjing/types.js";
import {
  LingjingUploadService,
  type UploadTransport
} from "../../src/uploads/upload-service.js";

const MEBIBYTE = 1024 * 1024;
const context = {
  sceneCode: "fixture-scene",
  modelCode: "fixture-model",
  spaceId: 42
};

interface CapturedCall {
  operation: string;
  path?: string;
  body?: unknown;
}

function bodyText(body: UploadRequest["body"]): Promise<string> {
  if (
    typeof body === "string"
    || Buffer.isBuffer(body)
    || body instanceof Uint8Array
  ) {
    return Promise.resolve(Buffer.from(body).toString("utf8"));
  }
  if (body instanceof FormData) return Promise.resolve("[FormData]");
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    body.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    body.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    body.on("error", reject);
  });
}

function mediaOfSize(size: number): PreparedMedia & {
  disposeCount: () => number;
  openedRanges: () => Array<[number | undefined, number | undefined]>;
} {
  let disposed = 0;
  const ranges: Array<[number | undefined, number | undefined]> = [];
  return {
    filename: "a.png",
    contentType: "image/png",
    size,
    openRead(start, endInclusive) {
      ranges.push([start, endInclusive]);
      const length = endInclusive === undefined
        ? size - (start ?? 0)
        : endInclusive - (start ?? 0) + 1;
      return Readable.from(Buffer.alloc(length));
    },
    dispose() {
      disposed += 1;
      return Promise.resolve();
    },
    disposeCount: () => disposed,
    openedRanges: () => ranges
  };
}

class MockUploadTransport implements UploadTransport {
  readonly calls: CapturedCall[] = [];
  maximumSimultaneousPartPuts = 0;
  private simultaneousPartPuts = 0;
  private partToFail: number | undefined;
  private strategy: "single" | "multipart" = "single";
  private readonly partCount = 6;

  useMultipart(): void {
    this.strategy = "multipart";
  }

  failPart(partNumber: number): void {
    this.partToFail = partNumber;
  }

  get operations(): string[] {
    return this.calls.map((call) => call.operation);
  }

  async uploadApi<T>(path: string, init: UploadRequest): Promise<T> {
    if (path === "/joycreator/upload/init") {
      this.calls.push({
        operation: "init",
        path,
        body: JSON.parse(await bodyText(init.body)) as unknown
      });
      const result = this.strategy === "single"
        ? {
            single: {
              uploadId: "upload-1",
              uploadUrl: "https://storage.test/single"
            }
          }
        : {
            multipart: {
              uploadId: "upload-1",
              totalParts: this.partCount,
              parts: Array.from({ length: this.partCount }, (_, index) => ({
                partNumber: index + 1,
                byteStart: index * 5 * MEBIBYTE,
                byteEndInclusive: (index + 1) * 5 * MEBIBYTE - 1,
                uploadUrl: `https://storage.test/part-${String(index + 1)}`
              }))
            }
          };
      return result as T;
    }
    if (path === "/joycreator/upload/complete") {
      this.calls.push({
        operation: "complete",
        path,
        body: JSON.parse(await bodyText(init.body)) as unknown
      });
      return {
        url: "",
        filePath: "fixture/uploads/a.png",
        frameUrl: null
      } as T;
    }
    if (path === "/joycreator/upload/cancel") {
      this.calls.push({
        operation: "cancel",
        path,
        body: JSON.parse(await bodyText(init.body)) as unknown
      });
      return { ok: true } as T;
    }
    if (path === "/joycreator/AIModelApiConsole/uploadMaterials") {
      this.calls.push({
        operation: "materials",
        path,
        body: await bodyText(init.body)
      });
      return {
        vender: "fixture-vendor",
        url: "fixture/materials/a.png",
        filePath: "",
        frameUrl: "fixture/materials/frame.png"
      } as T;
    }
    throw new Error(`Unexpected path ${path}`);
  }

  async putSigned(
    url: URL,
    init: UploadRequest
  ): Promise<SignedUploadResponse> {
    const partMatch = /part-(\d+)$/u.exec(url.pathname);
    const partNumber = partMatch?.[1] === undefined
      ? undefined
      : Number(partMatch[1]);
    this.calls.push({
      operation: partNumber === undefined
        ? "put-single"
        : `put-part-${String(partNumber)}`
    });
    this.simultaneousPartPuts += 1;
    this.maximumSimultaneousPartPuts = Math.max(
      this.maximumSimultaneousPartPuts,
      this.simultaneousPartPuts
    );
    try {
      await bodyText(init.body);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (
        this.partToFail !== undefined
        && partNumber === this.partToFail
      ) {
        throw new Error(`safe part ${String(partNumber)} failed`);
      }
      return { statusCode: 200, headers: {} };
    } finally {
      this.simultaneousPartPuts -= 1;
    }
  }
}

function generalUploads(mock: UploadTransport): LingjingUploadService {
  return new LingjingUploadService(mock, { uploadStrategy: "general" });
}

describe("Lingjing upload contract", () => {
  it("performs exact init, one PUT and complete for a small file", async () => {
    const mock = new MockUploadTransport();
    const media = mediaOfSize(1024);
    const material = await generalUploads(mock).upload(media, context);

    expect(material).toEqual({
      value: "fixture/uploads/a.png",
      filePath: "fixture/uploads/a.png",
      frameUrl: null,
      vendor: null
    });
    expect(mock.operations).toEqual(["init", "put-single", "complete"]);
    expect(mock.calls[0]?.body).toEqual({
      fileName: "a.png",
      fileSize: 1024,
      contentType: "image/png",
      sceneCode: "fixture-scene",
      modelCode: "fixture-model",
      spaceId: 42
    });
    expect(mock.calls[2]?.body).toEqual({
      uploadId: "upload-1",
      spaceId: 42
    });
    expect(media.openedRanges()).toEqual([[undefined, undefined]]);
    expect(media.disposeCount()).toBe(1);
  });

  it("limits multipart PUT concurrency to three and opens exact ranges", async () => {
    const mock = new MockUploadTransport();
    mock.useMultipart();
    const media = mediaOfSize(30 * MEBIBYTE);

    await generalUploads(mock).upload(media, context);

    expect(mock.maximumSimultaneousPartPuts).toBeLessThanOrEqual(3);
    expect(media.openedRanges()).toEqual(
      Array.from({ length: 6 }, (_, index) => [
        index * 5 * MEBIBYTE,
        (index + 1) * 5 * MEBIBYTE - 1
      ])
    );
    expect(media.disposeCount()).toBe(1);
  });

  it("cancels once after a part failure and rethrows the original error", async () => {
    const mock = new MockUploadTransport();
    mock.useMultipart();
    mock.failPart(2);
    const media = mediaOfSize(30 * MEBIBYTE);

    const error = await generalUploads(mock).upload(media, context).then(
      () => undefined,
      (cause: unknown) => cause
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("safe part 2 failed");
    expect(mock.operations.filter((operation) => operation === "cancel")).toHaveLength(1);
    expect(mock.operations).not.toContain("complete");
    expect(media.disposeCount()).toBe(1);
  });

  it("normalizes direct materials schema and sends required multipart fields", async () => {
    const mock = new MockUploadTransport();
    const media = mediaOfSize(3);
    const uploads = new LingjingUploadService(mock, {
      uploadStrategy: "materials"
    });

    const material: UploadedMaterial = await uploads.upload(media, context);

    expect(material).toEqual({
      value: "fixture/materials/a.png",
      filePath: "fixture/materials/a.png",
      frameUrl: "fixture/materials/frame.png",
      vendor: "fixture-vendor"
    });
    expect(mock.operations).toEqual(["materials"]);
    const multipartBody = String(mock.calls[0]?.body);
    expect(multipartBody).toContain('name="sceneCode"');
    expect(multipartBody).toContain("fixture-scene");
    expect(multipartBody).toContain('name="modelCode"');
    expect(multipartBody).toContain("fixture-model");
    expect(multipartBody).toContain('name="spaceId"');
    expect(multipartBody).toContain("42");
    expect(multipartBody).toContain('name="file"; filename="a.png"');
    expect(media.disposeCount()).toBe(1);
  });

  it("rejects malformed init responses, cancels if initialized, and disposes", async () => {
    const media = mediaOfSize(3);
    const failure = new Error("safe malformed response");
    const requestedPaths: string[] = [];
    const transport: UploadTransport = {
      uploadApi<T>(path: string, init: UploadRequest) {
        void init;
        requestedPaths.push(path);
        if (path === "/joycreator/upload/init") {
          return Promise.resolve(
            { single: { uploadId: "upload-1", uploadUrl: "" } } as T
          );
        }
        return Promise.reject(failure);
      },
      putSigned() {
        return Promise.reject(new Error("must not PUT"));
      }
    };

    await expect(
      generalUploads(transport).upload(media, context)
    ).rejects.toMatchObject({ code: "lingjing_upstream_error" });
    expect(requestedPaths).toEqual([
      "/joycreator/upload/init",
      "/joycreator/upload/cancel"
    ]);
    expect(media.disposeCount()).toBe(1);
  });

  it("preserves an upload failure when best-effort disposal also fails", async () => {
    const uploadFailure = new Error("safe upload failure");
    const media = mediaOfSize(3);
    media.dispose = () => Promise.reject(new Error("safe dispose failure"));
    const transport: UploadTransport = {
      uploadApi<T>() {
        return Promise.reject<T>(uploadFailure);
      },
      putSigned() {
        return Promise.reject(new Error("must not PUT"));
      }
    };

    await expect(
      generalUploads(transport).upload(media, context)
    ).rejects.toBe(uploadFailure);
  });

  it("sanitizes signed PUT URL credentials before rethrowing", async () => {
    const media = mediaOfSize(3);
    const transport: UploadTransport = {
      uploadApi<T>(path: string) {
        if (path === "/joycreator/upload/init") {
          return Promise.resolve({
            single: {
              uploadId: "upload-1",
              uploadUrl: "https://storage.test/a?token=secret#private"
            }
          } as T);
        }
        return Promise.resolve({ ok: true } as T);
      },
      putSigned() {
        return Promise.reject(
          new Error(
            "PUT https://storage.test/a?token=secret#private failed"
          )
        );
      }
    };

    const error = await generalUploads(transport).upload(media, context).then(
      () => undefined,
      (cause: unknown) => cause
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("secret");
    expect((error as Error).message).not.toContain("#private");
  });

  it("rejects a signed upload URL with embedded credentials", async () => {
    const media = mediaOfSize(3);
    let putCalled = false;
    const transport: UploadTransport = {
      uploadApi<T>(path: string) {
        if (path === "/joycreator/upload/init") {
          return Promise.resolve({
            single: {
              uploadId: "upload-1",
              uploadUrl: "https://user:pass@storage.test/a"
            }
          } as T);
        }
        return Promise.resolve({ ok: true } as T);
      },
      putSigned() {
        putCalled = true;
        return Promise.resolve({ statusCode: 200, headers: {} });
      }
    };

    await expect(
      generalUploads(transport).upload(media, context)
    ).rejects.toMatchObject({ code: "lingjing_upstream_error" });
    expect(putCalled).toBe(false);
  });
});
