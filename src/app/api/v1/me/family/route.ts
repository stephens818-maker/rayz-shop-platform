import { z } from "zod";
import { body, json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { addFamilyMember, listFamily } from "@/server/mobile/family";

export const OPTIONS = options;
export const GET = route(async (req) => json(await listFamily(await requireCustomer(req))));

const AddMember = z.object({
  firstName: z.string(),
  birthYear: z.number().int().optional(),
});

export const POST = route(async (req) => {
  const customerId = await requireCustomer(req);
  const input = await body(req, AddMember);
  return json(await addFamilyMember(customerId, input), 201);
});
