import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

const ADMIN_CLIENT_ROUTES = new Set([
  "/admin",
  "/admin/",
  "/admin/accounts",
  "/admin/tasks",
  "/admin/settings"
]);

export async function registerAdminStatic(
  app: FastifyInstance,
  enabled: boolean
): Promise<void> {
  const output = resolve(process.cwd(), "dist", "admin");
  const index = join(output, "index.html");
  const assets = join(output, "assets");
  if (!enabled || !existsSync(index) || !existsSync(assets)) return;

  await app.register(fastifyStatic, {
    root: assets,
    prefix: "/admin/assets/",
    immutable: true,
    maxAge: "1y",
    decorateReply: false
  });

  const sendIndex = async () => await readFile(index, "utf8");
  for (const route of ADMIN_CLIENT_ROUTES) {
    app.get(route, async (_request, reply) => reply
      .header("Cache-Control", "no-store")
      .type("text/html; charset=utf-8")
      .send(await sendIndex()));
  }
}

export { ADMIN_CLIENT_ROUTES };
