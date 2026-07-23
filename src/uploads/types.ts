import type { PreparedMedia, UploadedMaterial } from "../media/types.js";

/**
 * Calling `UploadService.upload` transfers ownership of `PreparedMedia`.
 * Every implementation must call `media.dispose()` exactly once from a
 * `finally` path before the returned promise settles, on success or failure.
 * Callers must dispose only media that was never passed to `upload`.
 */
export const UPLOAD_SERVICE_OWNS_PREPARED_MEDIA = true as const;

export interface UploadService {
  upload(
    media: PreparedMedia,
    context: { sceneCode: string; modelCode: string; spaceId: number }
  ): Promise<UploadedMaterial>;
}

export type InitUploadResult =
  | {
      uploadType: "single";
      uploadId: string;
      uploadUrl: string;
    }
  | {
      uploadType: "multipart";
      uploadId: string;
      totalParts: number;
      parts: Array<{
        partNumber: number;
        byteStart: number;
        byteEndInclusive: number;
        uploadUrl: string;
      }>;
    };

export type { UploadedMaterial } from "../media/types.js";
