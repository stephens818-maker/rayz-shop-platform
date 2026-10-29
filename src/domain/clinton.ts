/**
 * Clinton, Iowa is the pilot shop. It was never on Squire. Opening date, hours, phone and tax
 * stay blank until someone enters them. The credit card fee stays off until a rate is entered.
 */
export const CLINTON_PILOT = {
  slug: "clinton",
  name: "Clinton",
  address: "1320 11th St NW",
  address2: "Suite D",
  city: "Clinton",
  state: "IA" as const,
  zip: "52732",
  phone: null as string | null,
  timezone: "America/Chicago",
  /** Possession. Not an opening date. */
  possession: "2026-11-01",
  description:
    "Pilot shop. Never on Squire. Possession November 1, 2026. Opening date, hours and phone are not set. Sales tax stays at 0 until someone enters a rate. The credit card fee stays off until a rate is entered. If the app is down, take payment on paper and in the Stripe Dashboard.",
};
