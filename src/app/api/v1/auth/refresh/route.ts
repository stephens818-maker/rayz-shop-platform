import { body, json, options, route } from "@/server/api";
import { RefreshBody } from "@/server/api-schemas";
import { refresh } from "@/server/auth/customer";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const { refreshToken } = await body(req, RefreshBody);
  const r = await refresh(refreshToken);
  return json({ accessToken: r.accessToken, refreshToken: r.refreshToken, tokenType: r.tokenType, expiresIn: r.expiresIn });
});
