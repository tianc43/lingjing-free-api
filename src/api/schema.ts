import type { FastifySchema } from "fastify";
import { z } from "zod";

export const publicSecurity = [] as const;
export const bearerSecurity = [{ bearerAuth: [] }] as const;
export const emptyQuerySchema = z.object({}).strict();
export const upstreamDiagnosticsSchema = z.object({
  http_status: z.number().optional(), business_code: z.string().optional(), message: z.string().optional(), request_id: z.string().optional(),
  task_code: z.string().optional(), task_status: z.string().optional(), checked_at: z.number().optional(), state: z.enum(["verified", "unavailable"]).optional(),
  vendor: z.object({ code: z.string().optional(), error_code: z.string().optional(), message: z.string().optional() }).optional()
});
export const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string(),
    job_id: z.string().optional(), task_url: z.string().optional(), upstream: upstreamDiagnosticsSchema.optional()
  })
});

export function jsonSchema(
  schema: z.ZodType,
  io: "input" | "output" = "output"
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    io,
    target: "draft-07",
    unrepresentable: "any"
  }) as Record<string, unknown>;
  delete generated.$schema;
  return generated;
}

export function routeSchema(input: {
  security: typeof publicSecurity | typeof bearerSecurity;
  body?: z.ZodType;
  bodyContent?: Record<string, z.ZodType>;
  multipartBody?: z.ZodType;
  headers?: z.ZodType;
  params?: z.ZodType;
  querystring?: z.ZodType;
  response: Record<number, z.ZodType>;
  responseContent?: Record<number, Record<string, z.ZodType>>;
}): FastifySchema {
  const response = Object.fromEntries(
    Object.entries(input.response).map(([status, schema]) => [
      status,
      jsonSchema(schema)
    ])
  );
  for (const [status, content] of Object.entries(
    input.responseContent ?? {}
  )) {
    response[status] = {
      content: Object.fromEntries(
        Object.entries(content).map(([contentType, schema]) => [
          contentType,
          { schema: jsonSchema(schema) }
        ])
      )
    };
  }
  return {
    security: input.security,
    ...(input.multipartBody === undefined
      ? {}
      : { "x-multipart-body": jsonSchema(input.multipartBody, "input") }),
    ...(input.bodyContent === undefined
      ? input.body === undefined
        ? {}
        : { body: jsonSchema(input.body, "input") }
      : {
          body: {
            content: Object.fromEntries(
              Object.entries(input.bodyContent).map(
                ([contentType, schema]) => [
                  contentType,
                  { schema: jsonSchema(schema, "input") }
                ]
              )
            )
          }
        }),
    ...(input.headers === undefined
      ? {}
      : { headers: jsonSchema(input.headers, "input") }),
    ...(input.params === undefined
      ? {}
      : { params: jsonSchema(input.params, "input") }),
    ...(input.querystring === undefined
      ? {}
      : { querystring: jsonSchema(input.querystring, "input") }),
    response
  };
}
