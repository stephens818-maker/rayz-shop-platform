import { body, json, options, route } from "@/server/api";
import { DeleteConfirm } from "@/server/api-schemas";
import { confirmDeletion } from "@/server/mobile/account-deletion";

export const OPTIONS = options;

export const POST = route(async (req) => {
  const input = await body(req, DeleteConfirm);
  return json(await confirmDeletion(req, input.code ?? ""));
});
