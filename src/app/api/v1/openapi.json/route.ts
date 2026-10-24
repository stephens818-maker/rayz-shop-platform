import { json, route } from "@/server/api";
import { openApiDocument } from "@/server/openapi";

export const GET = route(async (req) => {
  const base = process.env.APP_BASE_URL ?? new URL(req.url).origin;
  return json(openApiDocument(base), 200, { "Cache-Control": "public, max-age=300" });
});
