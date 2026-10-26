import { body, json, options, route } from "@/server/api";
import { CardSetupBody } from "@/server/api-schemas";
import { assertSwitch } from "@/server/app-switches";
import { requireCustomer } from "@/server/auth/customer";
import { startCardSetup } from "@/server/payments/saved-cards";

export const OPTIONS = options;
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  await assertSwitch("payments");
  return json(await startCardSetup(id, await body(req, CardSetupBody)));
});
