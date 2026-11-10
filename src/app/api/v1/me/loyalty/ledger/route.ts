import { json, options, query, route } from "@/server/api";
import { LoyaltyLedgerQuery } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { loyaltyHistory } from "@/server/loyalty-ledger";

export const OPTIONS = options;
export const GET = route(async (req) => json(await loyaltyHistory(await requireCustomer(req), query(req, LoyaltyLedgerQuery))));
