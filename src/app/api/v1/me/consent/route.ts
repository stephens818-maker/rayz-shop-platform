import { body, json, options, route } from "@/server/api";
import { SetConsent } from "@/server/api-schemas";
import { requireCustomer } from "@/server/auth/customer";
import { consentState, requestConsentContext, setConsent } from "@/server/consent-events";

export const OPTIONS = options;
export const GET = route(async (req) => json(await consentState(await requireCustomer(req))));
export const PUT = route(async (req) => {
  const id = await requireCustomer(req);
  const b = await body(req, SetConsent);
  return json(await setConsent(id, b.changes, requestConsentContext(req)));
});
