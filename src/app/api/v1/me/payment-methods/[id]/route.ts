import { options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { detachCard } from "@/server/mobile/cards";

export const OPTIONS = options;

export const DELETE = route<{ id: string }>(async (req, { id }) => {
  await detachCard(await requireCustomer(req), id);
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
});
