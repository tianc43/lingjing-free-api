import { z } from "zod";
import type { AccountSnapshot } from "../lingjing/account.js";
import type { NormalizedModel } from "../models/types.js";
import type { JobRecord } from "../jobs/types.js";
import type { TaskResponse } from "./types.js";

const outputSchema = z.object({
  url: z.string(),
  posterUrl: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  duration: z.number().nullable(),
  format: z.string().nullable()
});

export const taskResponseSchema = z.object({
  id: z.string(),
  object: z.literal("lingjing.task"),
  kind: z.enum(["image", "video"]),
  model: z.string(),
  status: z.enum([
    "queued",
    "submitting",
    "discovering",
    "processing",
    "unknown",
    "completed",
    "failed"
  ]),
  created_at: z.number(),
  updated_at: z.number(),
  error: z.object({ code: z.string() }).nullable(),
  outputs: z.array(outputSchema)
});

const accountResponseSchema = z.object({
  object: z.literal("lingjing.account"),
  subject: z.string(),
  membership: z.string().nullable(),
  max_concurrency: z.number(),
  points_balance: z.number(),
  coupon_balance: z.number(),
  available_amount: z.number(),
  total_balance: z.number(),
  resource_packages: z.array(z.object({
    name: z.string(),
    balance: z.number()
  }))
});

const parameterResponseSchema = z.object({
  key: z.string(),
  display_name: z.string(),
  required: z.boolean(),
  type: z.enum(["string", "number", "boolean", "enum", "image-list"]),
  default: z.unknown().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  options: z.array(z.string()).optional(),
  max_files: z.number().optional()
});

const modelResponseSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  owned_by: z.literal("lingjing"),
  type: z.enum(["image", "video"]),
  mode: z.enum(["text-to-video", "image-to-video"]).optional(),
  display_name: z.string(),
  capabilities: z.object({
    text: z.boolean(),
    input_images: z.boolean()
  }),
  parameters: z.array(parameterResponseSchema),
  pricing: z.unknown()
});

export type AccountResponse = z.infer<typeof accountResponseSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;

const PRIVATE_PRICING_KEYS = new Set([
  "id",
  "apiid",
  "spaceid",
  "creationcode",
  "taskid",
  "modelcode",
  "refid",
  "rawrevision",
  "revision",
  "fingerprint",
  "hash",
  "upstreamid"
]);

function safePricing(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePricing);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      return PRIVATE_PRICING_KEYS.has(normalized)
        || normalized.includes("upstream")
        ? []
        : [[key, safePricing(entry)]];
    })
  );
}

export function presentTask(job: JobRecord): TaskResponse {
  return taskResponseSchema.parse({
    id: job.id,
    object: "lingjing.task",
    kind: job.kind,
    model: job.model,
    status: job.status,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    error: job.errorCode === null ? null : { code: job.errorCode },
    outputs: job.result?.outputs ?? []
  });
}

export function presentAccount(account: AccountSnapshot): AccountResponse {
  return accountResponseSchema.parse({
    object: "lingjing.account",
    subject: account.subject,
    membership: account.membership,
    max_concurrency: account.maxConcurrency,
    points_balance: account.pointsBalance,
    coupon_balance: account.couponBalance,
    available_amount: account.availableAmount,
    total_balance: account.totalBalance,
    resource_packages: account.resourcePackages
  });
}

export function presentPoints(account: AccountSnapshot): Omit<
  AccountResponse,
  "object" | "subject" | "membership" | "max_concurrency"
> {
  const presented = presentAccount(account);
  return {
    points_balance: presented.points_balance,
    coupon_balance: presented.coupon_balance,
    available_amount: presented.available_amount,
    total_balance: presented.total_balance,
    resource_packages: presented.resource_packages
  };
}

export function presentModel(model: NormalizedModel): ModelResponse {
  const isImage = model.sourceType === "image-generation";
  const parameters = model.parameters.map((parameter) => ({
    key: parameter.key,
    display_name: parameter.displayName,
    required: parameter.required,
    type: parameter.kind,
    ...(parameter.defaultValue === undefined
      ? {}
      : { default: parameter.defaultValue }),
    ...(parameter.minimum === undefined
      ? {}
      : { minimum: parameter.minimum }),
    ...(parameter.maximum === undefined
      ? {}
      : { maximum: parameter.maximum }),
    ...(parameter.options === undefined ? {} : { options: parameter.options }),
    ...(parameter.maxFiles === undefined
      ? {}
      : { max_files: parameter.maxFiles })
  }));
  return modelResponseSchema.parse({
    id: model.alias,
    object: "model",
    owned_by: "lingjing",
    type: isImage ? "image" : "video",
    ...(isImage ? {} : { mode: model.sourceType }),
    display_name: model.displayName,
    capabilities: {
      text: parameters.some((parameter) => parameter.type === "string"),
      input_images: parameters.some(
        (parameter) => parameter.type === "image-list"
      )
    },
    parameters,
    pricing: safePricing(model.pricing)
  });
}
