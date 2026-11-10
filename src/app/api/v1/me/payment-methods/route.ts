import { body, json, options, route } from "@/server/api";
import { SaveCardBody } from "@/server/api-schemas";
import { assertSwitch } from "@/server/app-switches";
import { requireCustomer } from "@/server/auth/customer";
import { listCards, publicCard, reAddCardPrompt, saveCard } from "@/server/payments/saved-cards";

export const OPTIONS = options;
export const GET = route(async (req) => {
  const id = await requireCustomer(req);
  const [cards, reAddPrompt] = await Promise.all([listCards(id), reAddCardPrompt(id)]);
  return json({ paymentMethods: cards.map(publicCard), reAddPrompt });
});
export const POST = route(async (req) => {
  const id = await requireCustomer(req);
  await assertSwitch("payments");
  return json({ paymentMethod: publicCard(await saveCard(id, await body(req, SaveCardBody))) }, 201);
});
