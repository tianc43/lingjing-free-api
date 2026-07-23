import { z } from "zod";

const parametersSchema = z.record(z.string(), z.unknown());
const inputImagesSchema = z.array(z.string().min(1)).max(14);

export const idempotencyKeySchema = z.string().min(8).max(200);

export const imageApiRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  n: z.number().int().min(1).max(14).optional(),
  size: z.string().min(1).optional(),
  response_format: z.enum(["url", "b64_json"]).default("url"),
  response_mode: z.enum(["wait", "async"]).default("wait"),
  input_images: inputImagesSchema.optional(),
  parameters: parametersSchema.optional()
}).strict();

export const videoApiRequestSchema = z.object({
  model: z.string().min(1),
  prompt: z.string().min(1),
  mode: z.enum(["text-to-video", "image-to-video"]),
  duration: z.number().optional(),
  resolution: z.string().min(1).optional(),
  ratio: z.string().min(1).optional(),
  input_images: inputImagesSchema.optional(),
  response_mode: z.enum(["wait", "async"]).default("wait"),
  parameters: parametersSchema.optional()
}).strict();

export interface ImageApiRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json";
  response_mode?: "wait" | "async";
  input_images?: string[];
  parameters?: Record<string, unknown>;
}

export interface VideoApiRequest {
  model: string;
  prompt: string;
  mode: "text-to-video" | "image-to-video";
  duration?: number;
  resolution?: string;
  ratio?: string;
  input_images?: string[];
  response_mode?: "wait" | "async";
  parameters?: Record<string, unknown>;
}

export const imageGenerationResponseSchema = z.object({
  created: z.number(),
  job_id: z.string(),
  data: z.array(z.union([
    z.object({ url: z.string() }).strict(),
    z.object({ b64_json: z.string() }).strict()
  ]))
});

export const videoGenerationResponseSchema = z.object({
  created: z.number(),
  job_id: z.string(),
  data: z.array(z.object({
    url: z.string(),
    poster_url: z.string().nullable(),
    width: z.number().nullable(),
    height: z.number().nullable(),
    duration: z.number().nullable(),
    format: z.string().nullable()
  }).strict())
});
