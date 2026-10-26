import { z } from "zod";

/** Request/response schemas for /api/v1. The OpenAPI document is generated from these. */

export const LocalDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date in America/Chicago, YYYY-MM-DD");
export const Instant = z.string().describe("ISO-8601 instant, e.g. 2026-10-21T15:00:00.000Z");
const Cents = z.number().int().describe("Amount in US cents");

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(["bad_request", "unauthorized", "forbidden", "not_found", "conflict", "slot_unavailable", "cutoff_passed", "rate_limited", "payment_failed", "upgrade_required", "internal"]),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
});

export const AppConfig = z.object({
  brand: z.object({ name: z.string(), supportEmail: z.string().nullable(), supportPhone: z.string().nullable() }),
  platforms: z.record(z.enum(["ios", "android"]), z.object({ minVersion: z.string().nullable(), latestVersion: z.string().nullable(), storeUrl: z.string().nullable() })),
  client: z
    .object({ platform: z.enum(["ios", "android"]), version: z.string().nullable(), updateRequired: z.boolean(), updateAvailable: z.boolean() })
    .nullable()
    .describe("This build's status, from X-Client and X-App-Version; null without X-Client"),
  maintenance: z.object({ active: z.boolean(), message: z.string().nullable() }),
  links: z.object({
    website: z.string(),
    account: z.string(),
    privacy: z.string().describe("Privacy policy. This site's /privacy unless APP_PRIVACY_URL points elsewhere; never null since 1.2"),
    terms: z.string().describe("Terms of service, including the SMS terms. This site's /terms unless APP_TERMS_URL is set"),
    support: z.string().describe("Added in 1.2. Help and contact page"),
    deleteAccount: z.string().describe("Added in 1.2. Public page to delete an account without the app (App Store and Play data-deletion URL)"),
  }),
  environment: z.enum(["production", "demo", "development"]),
  features: z
    .object({ booking: z.boolean(), payments: z.boolean(), family: z.boolean(), pushMarketing: z.boolean() })
    .describe("Added in 1.2. Kill switches: hide the matching screens when false. The server refuses those calls too (403, details.switch), so this is for a tidy UI, not the guard. Per-shop booking is Shop.bookingEnabled"),
});

export const ShopHours = z.object({ weekday: z.number().int().min(0).max(6).describe("0 = Sunday"), open: z.string(), close: z.string() });
export const Shop = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  address: z.string(),
  city: z.string(),
  state: z.string(),
  zip: z.string(),
  phone: z.string().nullable(),
  timezone: z.literal("America/Chicago"),
  bookingEnabled: z.boolean().describe("Clients can book this shop here (through this API). False for an external-booking shop"),
  bookingMode: z.enum(["platform", "external"]).describe("external: this shop still books on its old site; open externalBookingUrl instead of the booking flow"),
  externalBookingUrl: z.string().nullable().describe("https URL, set only when bookingMode is external"),
  cancelCutoffMinutes: z.number().int(),
  barberCount: z.number().int(),
  hours: z.array(ShopHours),
});
export const ShopList = z.object({ shops: z.array(Shop) });

export const Service = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  kind: z.enum(["service", "addon"]),
  category: z.string(),
  description: z.string().nullable(),
  priceCents: Cents,
  durationMin: z.number().int(),
});
export const ServiceList = z.object({ services: z.array(Service), addons: z.array(Service) });

export const Barber = z.object({
  id: z.string().uuid(),
  slug: z.string().describe("Surname-free slug used in booking links"),
  displayName: z.string().describe("First name or admin-set label, e.g. 'Taylor R.'"),
  color: z.string(),
  photoUrl: z.string().nullable(),
});
export const BarberList = z.object({ barbers: z.array(Barber) });

export const AvailabilityQuery = z.object({
  date: LocalDateStr,
  serviceId: z.string().uuid(),
  addonIds: z.string().optional().describe("Comma-separated add-on service IDs"),
  barber: z.string().optional().describe("'any' (default), a barber ID, or a barber slug"),
});
export const Slot = z.object({ startsAt: Instant, endsAt: Instant, barberIds: z.array(z.string().uuid()) });
export const Availability = z.object({
  shopId: z.string().uuid(),
  date: LocalDateStr,
  durationMin: z.number().int(),
  estimateCents: Cents,
  slots: z.array(Slot),
  reason: z.string().nullable().describe("Why there are no slots, when empty"),
});

export const AvailableDaysQuery = z.object({
  from: LocalDateStr,
  days: z.coerce.number().int().min(1).max(31).default(14),
  serviceId: z.string().uuid(),
  addonIds: z.string().optional(),
  barber: z.string().optional(),
});
export const AvailableDays = z.object({ days: z.array(z.object({ date: LocalDateStr, slots: z.number().int() })) });

export const CustomerInput = z.object({
  firstName: z.string().min(1).max(60),
  lastName: z.string().max(60).optional().nullable().describe("Stored privately; never shown publicly or put in URLs"),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  smsOptIn: z.boolean().optional().describe("Omit to keep the client's current choice; false always wins"),
  emailOptIn: z.boolean().optional().describe("Omit to keep the client's current choice; false always wins"),
});

export const CreateAppointment = z.object({
  shopId: z.string().describe("Shop ID or slug"),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).max(5).optional(),
  barberId: z.string().nullable().optional().describe("Barber ID or slug; null/'any' = any barber"),
  startsAt: Instant,
  customer: CustomerInput.optional().describe("Required unless authenticated with a customer bearer token"),
  notes: z.string().max(500).optional(),
});

export const Appointment = z.object({
  id: z.string().uuid(),
  code: z.string().describe("Unguessable reference used in manage links (/a/{code})"),
  status: z.enum(["booked", "confirmed", "checked_in", "in_service", "completed", "cancelled", "no_show"]),
  source: z.string(),
  startsAt: Instant,
  endsAt: Instant,
  shop: z.object({ id: z.string(), slug: z.string(), name: z.string(), address: z.string(), phone: z.string().nullable() }),
  barber: z.object({ id: z.string(), slug: z.string(), displayName: z.string() }),
  anyBarber: z.boolean(),
  customer: z.object({ id: z.string(), firstName: z.string() }).nullable(),
  items: z.array(z.object({ serviceId: z.string().nullable(), kind: z.enum(["service", "addon"]), name: z.string(), priceCents: Cents, durationMin: z.number().int() })),
  estimateCents: Cents,
  cancelCutoffAt: Instant,
  canCancel: z.boolean(),
  canReschedule: z.boolean(),
});
export const AppointmentEnvelope = z.object({ appointment: Appointment });
export const AppointmentList = z.object({ upcoming: z.array(Appointment), past: z.array(Appointment) });

export const CancelBody = z.object({ reason: z.string().max(200).optional() });
export const RescheduleBody = z.object({ startsAt: Instant, barberId: z.string().nullable().optional() });

export const OtpStart = z.object({
  phone: z.string().optional(),
  email: z.string().optional(),
  appHash: z
    .string()
    .regex(/^[A-Za-z0-9+/]{11}$/)
    .optional()
    .describe("Android only: the 11-character SMS Retriever hash, so the code text can be read without the SMS permission. Added in 1.2"),
});
export const OtpStartResponse = z.object({
  channel: z.enum(["sms", "email"]),
  expiresInSeconds: z.number().int(),
  devCode: z.string().optional().describe("Only present when AUTH_DEV_CODES=true (local/dev)"),
});
export const OtpVerify = z.object({
  phone: z.string().optional(),
  email: z.string().optional(),
  code: z.string().min(4).max(8),
  firstName: z.string().optional().describe("Required the first time (creates the account)"),
  lastName: z.string().optional(),
  deviceName: z.string().max(80).optional(),
});
export const Me = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  emailVerified: z.boolean().describe("Added in 1.2. Only a verified email signs in or matches a profile; emails typed at the shop or imported start unverified"),
  identityCheckRequired: z.boolean().describe("Added in 1.2. As on the token response: POST /me/identity-check before rewards can be redeemed"),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
  preferences: z
    .object({
      note: z.string().nullable().describe("The client's own note to their barber. Staff see it beside, never mixed with, their own notes"),
      updatedAt: Instant.nullable(),
      preferredBarber: z.object({ id: z.string().uuid(), slug: z.string(), displayName: z.string() }).nullable(),
    })
    .describe("Added in 1.1; older clients can ignore it"),
});
export const TokenResponse = z.object({
  needsProfile: z.literal(false),
  isNew: z.boolean(),
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().describe("Access token lifetime in seconds"),
  identityCheckRequired: z
    .boolean()
    .describe("Added in 1.2. True for a profile carried over from the old booking system that hasn't confirmed it's theirs: ask for POST /me/identity-check. Rewards can't be redeemed until it passes"),
  customer: Me,
});
const SelectionToken = z.string().describe("Valid 10 minutes. Send to /auth/otp/complete; no second code needed.");
export const NeedsProfile = z
  .object({ needsProfile: z.literal(true), selectionToken: SelectionToken })
  .describe("No single adult profile on this number or verified email (none, or a family sharing it). Ask for a first name and send it to /auth/otp/complete. The profiles on a number are never listed");
export const StepUpRequired = z
  .object({ needsProfile: z.literal(false), stepUp: z.literal("email"), selectionToken: SelectionToken, emailHint: z.string().describe("e.g. d•••@gmail.com") })
  .describe("Added in 1.2. The number hasn't been used here in 18 months and may have a new owner: send a code to the profile's verified email with /auth/step-up/start");
export const CantSignIn = z
  .object({ needsProfile: z.literal(false), cantSignIn: z.literal(true), selectionToken: SelectionToken, reason: z.literal("idle_number") })
  .describe("Added in 1.2. As stepUp, but the profile has no verified email: offer POST /auth/help so the shop can confirm and sign them in");
export const ChooseProfile = z
  .object({
    needsProfile: z.literal(false),
    chooseProfile: z.literal(true),
    selectionToken: SelectionToken,
    profiles: z.array(z.object({ id: z.string().uuid(), firstName: z.string(), lastInitial: z.string().nullable() })),
  })
  .describe("Deprecated in 1.2 and never returned: listing everyone on a number exposed them to whoever holds it next. Clients should treat it like needsProfile");
export const OtpComplete = z.object({
  selectionToken: z.string(),
  customerId: z.string().uuid().optional().describe("Deprecated in 1.2 and ignored; send firstName"),
  firstName: z.string().min(1).max(60).optional().describe("Matches an adult profile on this phone (or verified email) by name, else creates one"),
  lastName: z.string().max(60).optional(),
  deviceName: z.string().max(80).optional(),
});
export const StepUpStart = z.object({ selectionToken: z.string() });
export const StepUpVerify = z.object({ selectionToken: z.string(), code: z.string().min(4).max(8), deviceName: z.string().max(80).optional() });
export const SignInHelp = z.object({
  selectionToken: z.string().optional().describe("From verify/complete when the number was proven; attaches the profiles on it for staff"),
  phone: z.string().optional(),
  email: z.string().optional(),
  firstName: z.string().min(1).max(60),
  lastName: z.string().max(60).optional(),
  message: z.string().max(500).optional(),
});
export const Received = z.object({ received: z.literal(true) });
export const IdentityCheck = z.object({
  lastName: z.string().max(60).optional(),
  lastShop: z.string().max(80).optional().describe("Slug or name of the shop of their last visit"),
});
export const IdentityCheckResult = z.object({ verified: z.literal(true) });
export const DeletionQuery = z.object({ profileId: z.string().uuid().optional().describe("One of your children's profiles; omit for your own") });
export const DeletionPreview = z.object({
  profile: z.object({ id: z.string().uuid(), firstName: z.string() }),
  dependents: z.array(z.object({ id: z.string().uuid(), firstName: z.string() })).describe("Children's profiles deleted with it"),
  canDelete: z.boolean(),
  blockers: z.array(z.string()).describe("Why it can't be deleted yet (an active membership)"),
  forfeited: z.object({ loyaltyProgressCents: Cents, loyaltyRewardsCents: Cents, upcomingAppointments: z.number().int() }),
  giftCardBalanceCents: Cents.describe("Stays usable by code; only the link to the profile goes"),
  kept: z.object({ pastTickets: z.number().int(), explanation: z.string() }),
  timing: z.string(),
  consequences: z.array(z.string()).describe("Ready-to-show lines for the confirmation screen"),
});
export const DeleteAccount = z.object({
  code: z.string().min(4).max(8).describe("From POST /me/delete/start"),
  profileId: z.string().uuid().optional().describe("One of your children's profiles; omit for your own (which deletes your children's too)"),
});
export const Deleted = z.object({ deleted: z.literal(true), profiles: z.number().int() });
export const EmailChangeStart = z.object({ email: z.string().email() });
export const EmailChangeVerify = z.object({ email: z.string().email(), code: z.string().min(4).max(8) });
export const RefreshBody = z.object({ refreshToken: z.string() });
export const RefreshResponse = z.object({ accessToken: z.string(), refreshToken: z.string(), tokenType: z.literal("Bearer"), expiresIn: z.number().int() });
export const UpdateMe = z.object({
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().max(60).nullable().optional(),
  email: z
    .string()
    .email()
    .nullable()
    .optional()
    .describe("Deprecated in 1.2: only null (remove it) or the email already on file is accepted. Change it with /me/email/start and /me/email/verify"),
  smsOptIn: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
  preferencesNote: z.string().max(500).nullable().optional().describe("The client's note to their barber (e.g. 'low fade, no product'). null or '' clears it. Card numbers and contact details are removed"),
  preferredBarberId: z.string().nullable().optional().describe("Barber ID or slug; null clears it"),
});

export const Loyalty = z.object({
  enabled: z.boolean(),
  thresholdCents: Cents,
  rewardCents: Cents,
  progressCents: Cents,
  remainingCents: Cents,
  lifetimeEarnedCents: Cents,
  availableCents: Cents,
  rewards: z.array(z.object({ id: z.string(), amountCents: Cents, issuedAt: Instant, expiresAt: Instant.nullable() })),
  rules: z.object({ earn: z.string(), redeem: z.string(), expiry: z.string() }),
  redemptionLocked: z
    .boolean()
    .describe("Added in 1.2. True until an imported profile passes POST /me/identity-check; rewards and availableCents read empty meanwhile (progress still shows)"),
});
