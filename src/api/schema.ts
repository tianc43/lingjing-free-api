import type { FastifySchema } from "fastify";
import { z } from "zod";

export const publicSecurity = [] as const;
export const bearerSecurity = [{ bearerAuth: [] }] as const;
export const emptyQuerySchema = z.object({}).strict();
export const errorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.string().nullable(),
    code: z.string()
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
  params?: z.ZodType;
  querystring?: z.ZodType;
  response: Record<number, z.ZodType>;
}): FastifySchema {
  return {
    security: input.security,
    ...(input.body === undefined
      ? {}
      : { body: jsonSchema(input.body, "input") }),
    ...(input.params === undefined
      ? {}
      : { params: jsonSchema(input.params, "input") }),
    ...(input.querystring === undefined
      ? {}
      : { querystring: jsonSchema(input.querystring, "input") }),
    response: Object.fromEntries(
      Object.entries(input.response).map(([status, schema]) => [
        status,
        jsonSchema(schema)
      ])
    )
  };
}
