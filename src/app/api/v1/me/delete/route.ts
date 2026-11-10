import { customerActor } from "@/server/audit";
import { body, json, options, query, route } from "@/server/api";
import { DeleteAccount, DeletionQuery } from "@/server/api-schemas";
import { deleteAccount, deletionPreview } from "@/server/account-deletion";
import { checkDeletionCode, requireCustomer } from "@/server/auth/customer";

export const OPTIONS = options;
export const GET = route(async (req) => json(await deletionPreview(await requireCustomer(req), query(req, DeletionQuery).profileId)));
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, DeleteAccount);
  await checkDeletionCode(id, b.code);
  const source = req.headers.get("x-client") ?? "web";
  return json(await deleteAccount(customerActor(id), id, { profileId: b.profileId, source }));
});
