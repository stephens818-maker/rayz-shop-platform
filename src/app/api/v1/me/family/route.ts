import { body, json, options, route } from "@/server/api";
import { AddFamilyMember } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { addFamilyMember, listFamily } from "@/server/mobile/family";

export const OPTIONS = options;
export const GET = route(async (req) => json(await listFamily(await requireCustomer(req))));

export const POST = route(async (req) => {
  const customerId = await requireCustomer(req);
  const input = await body(req, AddFamilyMember);
  return json(await addFamilyMember(customerId, input), 201);
});
