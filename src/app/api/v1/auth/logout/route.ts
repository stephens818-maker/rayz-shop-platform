import { body, options, route } from "@/server/api";
import { RefreshBody } from "@/server/api-schemas";
import { revoke } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const { refreshToken } = await body(req, RefreshBody);
  await revoke(refreshToken);
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
});
