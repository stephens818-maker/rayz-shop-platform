import { z } from "zod";
import { body, json, options, route } from "@/server/api";
import { confirmDeletion } from "@/server/mobile/account-deletion";

export const OPTIONS = options;

const Confirm = z.object({ code: z.string().optional() });

export const POST = route(async (req) => {
  const input = await body(req, Confirm);
  return json(await confirmDeletion(req, input.code ?? ""));
});
