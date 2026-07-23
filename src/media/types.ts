export interface MediaInput {
  source:
    | {
        type: "buffer";
        data: Buffer;
        filename: string;
        contentType: string;
      }
    | { type: "data-uri"; value: string }
    | { type: "url"; value: string }
    | { type: "prepared"; media: PreparedMedia };
  kind: "image" | "video";
}

export interface PreparedMedia {
  filename: string;
  contentType: string;
  size: number;
  openRead(start?: number, endInclusive?: number): NodeJS.ReadableStream;
  dispose(): Promise<void>;
}

export interface UploadedMaterial {
  value: string;
  filePath: string;
  frameUrl: string | null;
  vendor: string | null;
}

export interface TempBudgetLease {
  growTo(bytes: number): void;
  release(): void;
}

export interface TempBudget {
  reserve(initialBytes: number): TempBudgetLease;
  usedBytes(): number;
}
