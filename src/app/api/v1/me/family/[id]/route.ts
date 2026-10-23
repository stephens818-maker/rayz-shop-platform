import { options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { removeFamilyMember } from "@/server/mobile/family";

export const OPTIONS = options;

export const DELETE = route<{ id: string }>(async (req, { id }) => {
  await removeFamilyMember(await requireCustomer(req), id);
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*" } });
});
