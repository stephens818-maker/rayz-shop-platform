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
  accounts: z
    .object({
      minimumAge: z.number().int().describe("I16: account holders are this age or older. Ask before creating an account; send ageConfirmed. Younger clients are dependents on a parent's account"),
      guestBooking: z.literal("web_only").describe("I14: the app books signed in; signed-out booking is the website's only"),
      turnstileSiteKey: z.string().nullable().describe("Website guest booking: the Cloudflare Turnstile site key when bot protection is on, else null"),
      reviewSignIn: z.boolean().describe("C18 scaffold: the App Review sign-in is switched on (FEATURE_REVIEW_LOGIN). Off unless the owner turns it on"),
    })
    .describe("Added in 1.2"),
  environment: z.enum(["production", "demo", "development"]),
  features: z
    .object({ booking: z.boolean(), payments: z.boolean(), family: z.boolean(), pushMarketing: z.boolean() })
    .describe("Added in 1.2. Kill switches: hide the matching screens when false. The server refuses those calls too (403, details.switch), so this is for a tidy UI, not the guard. Per-shop booking is Shop.bookingEnabled"),
  payments: z
    .object({
      mode: z.enum(["stripe", "simulator"]).describe("simulator: no Stripe keys on this server; use the test cards and tokens the endpoints list"),
      publishableKey: z.string().nullable(),
      merchantDisplayName: z.string(),
      merchantCountryCode: z.literal("US"),
      applePayMerchantId: z.string().nullable().describe("null: don't offer Apple Pay yet"),
      googlePayTestEnv: z.boolean(),
      walletFee: z.boolean().describe("Whether the credit card surcharge applies to Apple Pay and Google Pay. Off unless the owner turns it on"),
    })
    .describe("Added in 1.2. PaymentSheet settings for saved cards and paying tickets"),
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
export const ShopDetail = Shop.extend({
  policies: z
    .object({
      cancellation: z.string().nullable().describe("The shop's cancellation policy, as shown on the booking site before a client confirms; null when it has none"),
      noShow: z.string().nullable(),
      cancelCutoffMinutes: z.number().int().describe("The same as the shop's cancelCutoffMinutes; a barber's own cutoff shows on each appointment's cancelCutoffAt"),
    })
    .describe("Added in 1.2. Plain text (no deposits or no-show fees are charged)"),
});

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
  ageConfirmed: z.boolean().optional().describe("I16: they're 13 or older. false is refused (403 under_13); the website sends true from its checkbox"),
});

export const CreateAppointment = z.object({
  shopId: z.string().describe("Shop ID or slug"),
  serviceId: z.string().uuid(),
  addonIds: z.array(z.string().uuid()).max(5).optional(),
  barberId: z.string().nullable().optional().describe("Barber ID or slug; null/'any' = any barber"),
  startsAt: Instant,
  customer: CustomerInput.optional().describe(
    "Website guests only. The app must send a customer bearer token (401 sign_in_required otherwise). A guest never lands on an existing profile: a matching phone or email gets a separate unverified record until that phone signs in with a code.",
  ),
  captchaToken: z.string().max(4096).optional().describe("Website guests, when bot protection is on (app config accounts.turnstileSiteKey): the Cloudflare Turnstile token"),
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
export const AppointmentList = z.object({
  upcoming: z.array(Appointment),
  past: z.array(Appointment),
  nextCursor: z
    .object({ upcoming: z.string().nullable(), past: z.string().nullable() })
    .optional()
    .describe("Pass one as ?cursor= for that list's next page (the response is then an AppointmentPage); null at the end"),
});
export const AppointmentPage = z.object({ appointments: z.array(Appointment), nextCursor: z.string().nullable().describe("Pass as ?cursor= for the next page; null at the end") });
const Flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");
export const AppointmentListQuery = z.object({
  status: z.enum(["upcoming", "past", "cancelled"]).optional().describe("One list, paged: upcoming (soonest first), past (any status) or cancelled (any date), newest first"),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(400).optional(),
  family: Flag.optional().describe("Include the children on my account; each appointment's customer says whose it is"),
});

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
const AgeConfirmed = z
  .boolean()
  .optional()
  .describe(
    "Added in 1.2 (I16). They said they're 13 or older. Creating an account with false is refused (403 under_13); the app (X-Client ios/android) must send true to create one (400 age_confirmation_required). Ignored when signing into an existing profile",
  );
export const OtpVerify = z.object({
  phone: z.string().optional(),
  email: z.string().optional(),
  code: z.string().min(4).max(8),
  firstName: z.string().optional().describe("Required the first time (creates the account)"),
  lastName: z.string().optional(),
  deviceName: z.string().max(80).optional(),
  ageConfirmed: AgeConfirmed,
});
const ReceiptDelivery = z
  .enum(["email", "app"])
  .describe("email: to the verified email. app: on GET /me/receipts, with a push (data.kind = receipt) when appointment notifications are on. A child's receipts go to the parent");
export const Me = z.object({
  id: z.string().uuid(),
  firstName: z.string(),
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  emailVerified: z.boolean().describe("Added in 1.2. Only a verified email signs in or matches a profile; emails typed at the shop or imported start unverified"),
  secured: z.boolean().describe("Added in 1.2 (I15). Signing in by phone also needs a code to the verified email. PUT /me/secure turns it on or off"),
  identityCheckRequired: z.boolean().describe("Added in 1.2. As on the token response: POST /me/identity-check before rewards can be redeemed"),
  smsOptIn: z.boolean().describe("Appointment texts"),
  emailOptIn: z.boolean().describe("Appointment emails"),
  pushTransactional: z.boolean().describe("Added in 1.2. Appointment notifications in the app. Change consent with PUT /me/consent"),
  smsMarketingOptIn: z.boolean().describe("Added in 1.2. Offer and opening texts, a separate yes from appointment texts"),
  emailMarketingOptIn: z.boolean().describe("Added in 1.2"),
  pushMarketing: z.boolean().describe("Added in 1.2"),
  receiptDelivery: ReceiptDelivery.nullable().describe("Added in 1.2. Where receipts go on paying at the counter; null asks at checkout"),
  homeShop: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }).nullable().describe("Added in 1.2. The client's usual shop"),
  birthday: LocalDateStr.nullable().describe("Added in 1.2"),
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
  .object({
    needsProfile: z.literal(false),
    stepUp: z.literal("email"),
    selectionToken: SelectionToken,
    emailHint: z.string().describe("e.g. d•••@gmail.com"),
    reason: z.enum(["idle_number", "secured"]).describe("idle_number: unused here in 18 months, it may have a new owner. secured: the client turned on Secure my profile (I15)"),
  })
  .describe("Added in 1.2. Send a code to the profile's verified email with /auth/step-up/start, then /auth/step-up/verify");
export const CantSignIn = z
  .object({ needsProfile: z.literal(false), cantSignIn: z.literal(true), selectionToken: SelectionToken, reason: z.enum(["idle_number", "secured"]) })
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
  ageConfirmed: AgeConfirmed,
});
export const SecureBody = z.object({ secured: z.boolean() });
export const SecureResult = z.object({ secured: z.boolean() });
export const ClaimChildBody = z.object({
  firstName: z.string().trim().min(1).max(60).describe("The child's first name as the shop has it"),
  birthYear: z.number().int().min(1900).max(2200).optional().describe("Passed to the shop when it has to check first"),
});
export const ClaimChildResult = z.object({
  status: z.enum(["converted", "requested"]).describe("converted: now a dependent on your account. requested: the shop will check and move it"),
  childId: z.string().uuid().optional(),
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
const ConsentChannelEnum = z.enum(["sms_transactional", "email", "push_transactional", "sms_marketing", "email_marketing", "push_marketing"]);
export const ConsentStateSchema = z.object({
  channels: z.array(
    z.object({
      channel: ConsentChannelEnum,
      label: z.string(),
      marketing: z.boolean(),
      granted: z.boolean(),
      text: z.string().describe("Show this beside an unchecked box. Changing it changes textVersion"),
      textVersion: z.string().describe("Send it back with a yes, so the record shows which wording was agreed to"),
      changedAt: Instant.nullable(),
      changedVia: z.enum(["ios", "android", "web", "pos", "import", "sms", "email"]).nullable(),
      blockedBy: z.enum(["stop", "no_phone", "no_verified_email"]).nullable().describe("stop: the number replied STOP, so texts wait until it texts START"),
    }),
  ),
});
export const SetConsent = z.object({
  changes: z
    .array(z.object({ channel: ConsentChannelEnum, granted: z.boolean(), textVersion: z.string().max(60).optional().describe("Required for a yes: the version of the text shown") }))
    .min(1)
    .max(6),
});
export const DeviceSchema = z.object({
  id: z.string().uuid(),
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  appVersion: z.string().nullable(),
  osVersion: z.string().nullable(),
  pushEnabled: z.boolean(),
  lastSeenAt: Instant,
  createdAt: Instant,
});
export const RegisterDevice = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]).describe("apns on iOS, fcm on Android. expo tokens are stored but not sent to"),
  token: z.string().min(8).max(4096),
  appVersion: z.string().max(40).nullable().optional(),
  osVersion: z.string().max(40).nullable().optional(),
  locale: z.string().max(20).nullable().optional(),
  pushEnabled: z.boolean().optional().describe("The phone's notification permission; default true"),
});
export const UpdateDevice = z.object({
  token: z.string().min(8).max(4096).optional().describe("The OS rotated the token"),
  pushEnabled: z.boolean().optional(),
  appVersion: z.string().max(40).nullable().optional(),
  osVersion: z.string().max(40).nullable().optional(),
  locale: z.string().max(20).nullable().optional(),
});
export const SessionSchema = z.object({
  id: z.string().uuid(),
  deviceName: z.string().nullable().describe("deviceName sent at sign-in"),
  signedInAt: Instant,
  lastActiveAt: Instant.describe("The last token refresh"),
  current: z.boolean().describe("The session making this request"),
});
export const SessionList = z.object({ sessions: z.array(SessionSchema) });
export const SessionsEnded = z.object({ ended: z.number().int() });
export const ReceiptListQuery = z.object({
  before: z.string().datetime({ offset: true }).optional().describe("nextBefore from the previous page"),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});
const ReceiptStatus = z.enum(["paid", "voided", "refunded", "partially_refunded"]);
export const ReceiptSummary = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  status: ReceiptStatus,
  paidAt: Instant,
  totalCents: Cents,
  refundedCents: Cents,
  shop: z.object({ id: z.string().uuid(), name: z.string() }),
  forFirstName: z.string().nullable().describe("Whose visit: the client, or a child on their account"),
  deliveredBy: z.enum(["sms", "email", "app", "none"]).nullable().describe("Where the latest receipt for it went; none = no receipt wanted"),
});
export const ReceiptDetail = z.object({
  id: z.string().uuid(),
  number: z.number().int(),
  status: ReceiptStatus,
  paidAt: Instant,
  voidedAt: Instant.nullable(),
  shop: z.object({ name: z.string(), title: z.string(), address: z.string().nullable(), phone: z.string().nullable(), logoUrl: z.string().nullable(), footer: z.string() }),
  forFirstName: z.string().nullable(),
  barber: z.string().nullable(),
  lines: z.array(z.object({ name: z.string(), kind: z.string(), qty: z.number().int(), cents: z.number().int(), refundedQty: z.number().int() })),
  people: z.array(z.object({ name: z.string(), barbers: z.array(z.string()), cents: z.number().int() })).nullable().describe("A ticket for several people: the total per person"),
  discounts: z.array(z.object({ label: z.string(), cents: z.number().int() })),
  subtotalCents: z.number().int(),
  taxCents: Cents,
  tipCents: Cents,
  fee: z.object({ label: z.string(), cents: Cents }).nullable().describe("The card fee, when one was charged"),
  totalCents: z.number().int(),
  tenders: z.array(z.object({ label: z.string(), cents: z.number().int() })).describe("e.g. Visa •••• 4242, Cash, Gift card"),
  refunds: z.array(z.object({ label: z.string(), cents: Cents, at: Instant })),
  refundedCents: Cents,
  disclosures: z.array(z.string()),
  loyalty: z.string().nullable(),
  rebookPath: z.string().nullable().describe("Web path to book the same again, when the shop takes online bookings"),
});
const CardFundingEnum = z.enum(["credit", "debit", "prepaid", "unknown"]);
export const SavedCardSchema = z.object({
  id: z.string().uuid(),
  paymentMethodId: z.string().describe("Stripe PaymentMethod (pm_...): pay with it as paymentMethodId"),
  brand: z.string(),
  last4: z.string(),
  funding: CardFundingEnum.describe("Only credit pays the shop's card surcharge"),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
  wallet: z.string().nullable(),
  isDefault: z.boolean(),
  createdAt: Instant,
});
export const SavedCardList = z.object({
  paymentMethods: z.array(SavedCardSchema),
  reAddPrompt: z.boolean().describe("The client came over from Squire and has no card here yet: Squire's saved cards don't carry over, so ask them to add one"),
});
export const CardSetupBody = z.object({ stripeVersion: z.string().max(40).nullable().optional().describe("The Stripe API version of the app's Stripe SDK, for the ephemeral key. Required with Stripe keys") });
export const CardSetupSchema = z.object({
  mode: z.enum(["stripe", "simulator"]),
  publishableKey: z.string().nullable(),
  customerId: z.string().describe("The account holder's Stripe Customer (platform-level: one card works at every shop)"),
  ephemeralKeySecret: z.string().nullable(),
  setupIntentId: z.string(),
  setupIntentClientSecret: z.string(),
  merchantDisplayName: z.string(),
  merchantCountryCode: z.literal("US"),
  applePayMerchantId: z.string().nullable(),
  googlePayTestEnv: z.boolean(),
  testCards: z.array(z.object({ id: z.string(), label: z.string() })).describe("Simulator only: send one as paymentMethodId to POST /me/payment-methods"),
});
export const SaveCardBody = z.object({
  setupIntentId: z.string().max(255).nullable().optional().describe("The SetupIntent PaymentSheet completed"),
  paymentMethodId: z.string().max(255).nullable().optional().describe("Simulator: a test card id. With Stripe: a PaymentMethod already attached to your Customer"),
});
const TipChoice = {
  tipChoice: z.string().max(40).describe("A tips.choices key, custom, none, or per_barber"),
  tipCents: z.number().int().min(0).max(100_000).optional().describe("For custom"),
  tipByStaff: z
    .array(z.object({ staffId: z.string().uuid(), cents: z.number().int().min(0) }))
    .max(10)
    .nullable()
    .optional()
    .describe("For per_barber: each barber's tip, one per tipBarbers entry"),
};
export const QuoteBody = z.object({ ...TipChoice, paymentMethodId: z.string().min(3).max(255).describe("A saved card (pm_...) or the ConfirmationToken (ctoken_...) FlowController made") });
export const PayBody = z.object({
  ...TipChoice,
  paymentMethodId: z.string().min(3).max(255).optional(),
  expectedTotalCents: z.number().int().min(0).optional().describe("totalCents from the quote. Required unless paymentIntentId"),
  paymentIntentId: z.string().max(255).optional().describe("After handling requires_action: the intent to finish. The tip and card are the ones sent first"),
});
export const AppTicketSummary = z.object({
  id: z.string().uuid(),
  shop: z.string(),
  ticketNumber: z.number().int(),
  forFirstName: z.string().nullable(),
  dueCents: Cents,
  sentAt: Instant,
});
export const AppTicketSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["open", "paid", "withdrawn"]).describe("withdrawn: the shop took it back to pay at the counter"),
  saleId: z.string().uuid().describe("The receipt id once paid"),
  shop: z.object({ name: z.string(), logoUrl: z.string().nullable() }),
  ticketNumber: z.number().int(),
  barbers: z.array(z.string()),
  lines: z.array(z.object({ name: z.string(), qty: z.number().int(), cents: z.number().int() })),
  discounts: z.array(z.object({ label: z.string(), cents: z.number().int() })),
  servicesCents: Cents,
  taxCents: Cents,
  giftCardCents: Cents,
  dueCents: Cents.describe("Before any card surcharge, the tip chosen so far included"),
  tip: z.object({ cents: z.number().int().nullable(), choice: z.string().nullable() }),
  tips: z.object({
    choices: z.array(z.object({ key: z.string(), label: z.string(), detail: z.string().nullable(), cents: Cents })),
    allowCustom: z.boolean(),
    allowNoTip: z.boolean(),
  }),
  tipBarbers: z.array(z.object({ staffId: z.string().uuid(), label: z.string(), servicesCents: Cents })),
  cardFee: z.object({ enabled: z.boolean(), rate: z.number(), appliesToTip: z.boolean(), walletFee: z.boolean(), notice: z.string().nullable() }),
  pay: z.object({
    mode: z.enum(["stripe", "simulator"]),
    cards: z.boolean().describe("false: this shop can't take cards right now; pay at the counter"),
    publishableKey: z.string().nullable(),
    merchantDisplayName: z.string(),
    applePayMerchantId: z.string().nullable(),
    testTokens: z.array(z.object({ id: z.string(), label: z.string() })).describe("Simulator only: stand-ins for FlowController's ConfirmationToken"),
  }),
  paidAt: Instant.nullable(),
});
export const AppQuoteSchema = z.object({
  card: z.object({ brand: z.string(), last4: z.string(), funding: CardFundingEnum, wallet: z.string().nullable(), saved: z.boolean() }),
  tipCents: Cents,
  dueCents: Cents,
  feeCents: Cents,
  feeReason: z.enum(["applies", "not_credit", "wallet_fee_off", "disabled", "zero_amount"]),
  feeLabel: z.string().nullable(),
  chargeCents: Cents.describe("What goes on the card"),
  totalCents: Cents.describe("Send as expectedTotalCents"),
  disclosures: z.array(z.string()),
});
export const AppPayResultSchema = z.object({
  status: z.enum(["paid", "requires_action"]),
  receipt: ReceiptDetail.optional().describe("When paid"),
  paymentIntentId: z.string().optional().describe("requires_action: handle it with the client secret, then POST again with this"),
  clientSecret: z.string().optional(),
});
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
  receiptDelivery: ReceiptDelivery.nullable().optional().describe("Added in 1.2. email needs a verified email; null goes back to being asked at checkout"),
  homeShopId: z.string().max(80).nullable().optional().describe("Added in 1.2. Shop ID or slug; null clears it"),
  birthday: LocalDateStr.nullable().optional().describe("Added in 1.2. Account holders are 13 or older; null clears it"),
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
export const LoyaltyLedgerQuery = z.object({ cursor: z.string().max(400).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
export const LoyaltyLedgerEntry = z.object({
  id: z.string().uuid(),
  kind: z.enum(["earn", "reverse", "reward_issued", "reward_redeemed", "import", "expire", "merge", "convert"]).describe("New kinds may be added; show label for any you don't know"),
  label: z.string().describe("Ready to show, e.g. Earned on a visit, Brought over from Squire"),
  progressDelta: z.number().int().describe("Change in progress, in unit"),
  unit: z.enum(["cents", "visits"]),
  rewardCents: z.number().int().describe("Rewards earned (positive) or used (negative)"),
  imported: z.boolean().describe("The balance brought over from Squire at the switch"),
  createdAt: Instant,
  receiptId: z.string().uuid().nullable().describe("GET /me/receipts/{id}; null for imports and adjustments"),
  receiptNumber: z.number().int().nullable(),
  forFirstName: z.string().nullable().describe("Whose visit it was (a child on a household card)"),
  shop: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string() }).nullable(),
});
export const LoyaltyLedger = z.object({
  entries: z.array(LoyaltyLedgerEntry),
  nextCursor: z.string().nullable().describe("Pass as ?cursor= for the next page; null at the end"),
  redemptionLocked: z.boolean().describe("True until an imported profile passes POST /me/identity-check; entries are empty meanwhile"),
});
export const SuggestedRebook = z.object({
  customer: z.object({ id: z.string().uuid(), firstName: z.string(), isChild: z.boolean() }),
  lastVisit: z.object({
    date: LocalDateStr,
    shop: z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), bookable: z.boolean() }),
    barber: z.object({ id: z.string().uuid(), slug: z.string(), displayName: z.string(), bookable: z.boolean().describe("False when the barber no longer takes bookings; offer any barber") }),
    services: z.array(z.object({ serviceId: z.string().uuid().nullable(), kind: z.string(), name: z.string(), bookable: z.boolean() })),
  }),
  intervalDays: z.number().int(),
  intervalSource: z.enum(["client", "service", "brand"]).describe("client: their own usual interval; service: the main service's; brand: the default"),
  suggestedDate: LocalDateStr,
  daysUntil: z.number().int().describe("Negative when overdue"),
  nextVisit: z.object({ code: z.string(), startsAt: Instant }).nullable().describe("Already booked: show this instead of a nudge"),
});
export const SuggestedRebookList = z.object({ suggestions: z.array(SuggestedRebook) });
