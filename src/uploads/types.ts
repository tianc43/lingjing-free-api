import type { PreparedMedia, UploadedMaterial } from "../media/types.js";

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
