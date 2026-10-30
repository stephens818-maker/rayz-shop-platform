import { json, options, route } from "@/server/api";
import { requireCustomer } from "@/server/auth/customer";
import { publicCard, setDefaultCard } from "@/server/payments/saved-cards";

export const OPTIONS = options;
export const POST = route<{ id: string }>(async (req, { id }) => json({ paymentMethod: publicCard(await setDefaultCard(await requireCustomer(req), id)) }));
