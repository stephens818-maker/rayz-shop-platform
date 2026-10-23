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

export const ShopHours = z.object({
  weekday: z.number().int().min(0).max(6).describe("0 = Sunday"),
  open: z.string(),
  close: z.string(),
  openLabel: z.string().describe("12-hour America/Chicago label"),
  closeLabel: z.string().describe("12-hour America/Chicago label"),
});
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
  bookingEnabled: z.boolean(),
  bookingMode: z.enum(["native", "external", "closed"]),
  externalBookingUrl: z.string().nullable(),
  cancelCutoffMinutes: z.number().int(),
  cancellationPolicy: z.string(),
  barberCount: z.number().int(),
  hours: z.array(ShopHours),
  description: z.string().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  photoUrl: z.string().nullable(),
  mapsUrl: z.string(),
  googleReviewUrl: z.string().nullable(),
  openNow: z.boolean(),
  closures: z.array(z.object({ date: z.string(), reason: z.string().nullable() })),
  tipPresets: z.array(z.number()),
  cardFeeMayApply: z.boolean(),
  cardFeeDisclosure: z.string().nullable(),
  nextSlot: z.object({ startsAt: z.string(), serviceId: z.string() }).nullable(),
  /** False until this shop's own launch instant. Null on the shop means it is still on Squire. */
  launched: z.boolean(),
  launchAt: z.string().nullable(),
  /** Sentence to show when launched is false. Null when the shop is live. */
  closedCopy: z.string().nullable(),
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

export const OtpStart = z.object({ phone: z.string().optional(), email: z.string().optional() });
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
  lastName: z.string().nullable().describe("The customer's own last name, only on GET /me. Staff and other customer surfaces get the first name."),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  emailVerifiedAt: z.string().nullable(),
  smsOptIn: z.boolean().describe("Defaults to false. Opting in, including after an opt-out, requires consentTextVersion and writes a new consent record."),
  emailOptIn: z.boolean(),
  smsMarketingOptIn: z.boolean(),
  emailMarketingOptIn: z.boolean(),
  pushTransactional: z.boolean(),
  pushMarketing: z.boolean(),
  homeShopId: z.string().uuid().nullable(),
  preferredBarberId: z.string().uuid().nullable(),
  preferredBarber: z.object({ id: z.string().uuid(), firstName: z.string() }).nullable(),
  birthday: z.string().nullable(),
  birthYear: z.number().int().nullable(),
  /** Written by the customer for the barber. Staff notes are never returned. */
  preferences: z.string().nullable(),
  notes: z.string().nullable().describe("Same as preferences: the customer's own note. Staff notes are never returned."),
  secureProfile: z.boolean(),
  identityConfirmed: z.boolean(),
  redemptionLocked: z.boolean(),
  badge: z.object({
    tier: z.enum(["gold", "silver", "bronze", "new"]),
    label: z.string(),
    color: z.string(),
    reason: z.string(),
    since: z.string().nullable(),
  }),
});
export const TokenResponse = z.object({
  needsProfile: z.literal(false),
  isNew: z.boolean(),
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal("Bearer"),
  expiresIn: z.number().int().describe("Access token lifetime in seconds"),
  customer: Me,
});
const SelectionToken = z.string().describe("Valid 10 minutes. Send to /auth/otp/complete; no second code needed.");
export const NeedsProfile = z.object({ needsProfile: z.literal(true), selectionToken: SelectionToken });
export const ChooseProfile = z.object({
  needsProfile: z.literal(false),
  chooseProfile: z.literal(true),
  selectionToken: SelectionToken,
  profiles: z
    .array(z.object({ id: z.string().uuid(), firstName: z.string() }))
    .describe("Everyone on this phone or email (families share). First names only. Ask which one is signing in."),
});
export const OtpComplete = z.object({
  selectionToken: z.string(),
  customerId: z.string().uuid().optional().describe("One of the profiles from chooseProfile"),
  firstName: z.string().min(1).max(60).optional().describe("Or a name: matches a profile on this phone, else creates one"),
  lastName: z.string().max(60).optional(),
  deviceName: z.string().max(80).optional(),
  birthYear: z.number().int().min(1900).max(2100).optional().describe("Required for a new ios/android account. Must be 13 or older."),
});
export const RefreshBody = z.object({ refreshToken: z.string() });
export const RefreshResponse = z.object({ accessToken: z.string(), refreshToken: z.string(), tokenType: z.literal("Bearer"), expiresIn: z.number().int() });
export const UpdateMe = z.object({
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().max(60).nullable().optional(),
  smsOptIn: z.boolean().optional().describe("False is the default. True, including opting back in, requires consentTextVersion."),
  emailOptIn: z.boolean().optional(),
  smsMarketingOptIn: z.boolean().optional(),
  emailMarketingOptIn: z.boolean().optional(),
  pushTransactional: z.boolean().optional(),
  pushMarketing: z.boolean().optional(),
  homeShopId: z.string().uuid().nullable().optional(),
  preferredBarberId: z.string().uuid().nullable().optional(),
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  preferences: z.string().max(500).nullable().optional(),
  notes: z.string().max(500).nullable().optional().describe("Customer note for the shop. Staff notes cannot be set here."),
  secureProfile: z.boolean().optional(),
  consentTextVersion: z.string().max(40).optional().describe("Required by TCPA to turn a channel on, including opting back in after an opt-out. A new consent record is stored."),
  /** Rejected. Email changes go through POST /me/email/start. */
  email: z.never().optional(),
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
});

const RefundFrom = z.enum(["shop", "tip", "shop_and_tip"]);
export const Settlement = z.object({
  shopCents: Cents,
  tipCents: Cents,
  tipStatus: z.enum(["executed", "planned", "reversed", "failed", "skipped", "with_shop"]),
  transferGroup: z.string().nullable(),
});
export const RefundRecord = z.object({
  id: z.string(),
  createdAt: z.string().nullable(),
  amountCents: Cents,
  serviceCents: Cents,
  productCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  feeCents: Cents.describe("Surcharge returned with this refund, prorated when the refund is partial"),
  shopPortionCents: Cents.nullable(),
  tipPortionCents: Cents.nullable(),
  from: RefundFrom.nullable(),
});

export const RegisterDevice = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  token: z.string().min(8).max(4096),
  appVersion: z.string().max(40).optional(),
  osVersion: z.string().max(40).optional(),
  locale: z.string().max(20).optional(),
});
export const Device = z.object({
  id: z.string().uuid(),
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  lastSeenAt: Instant,
});
export const DeviceList = z.object({ devices: z.array(Device) });
export const DeviceRegistered = Device;
export const DeviceRevoked = z.object({ ok: z.literal(true) });

export const AppConfigShop = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  launched: z.boolean(),
  launchAt: z.string().nullable(),
  closedCopy: z.string().nullable(),
  shopId: z.string().uuid(),
  booking: z.enum(["native", "external", "closed"]),
  externalBookingUrl: z.string().nullable(),
  payments: z.boolean(),
  clockIn: z.literal(false),
  tipTransfers: z.boolean(),
});
export const AppConfig = z.object({
  minIos: z.string(),
  minAndroid: z.string(),
  latestIos: z.string(),
  latestAndroid: z.string(),
  iosStoreUrl: z.string(),
  androidStoreUrl: z.string(),
  flags: z.object({
    payments: z.boolean(),
    family: z.boolean(),
    pushMarketing: z.boolean(),
    appReviewLogin: z.boolean(),
    walletCardFee: z.boolean(),
    perShopBooking: z.boolean(),
  }),
  timezone: z.literal("America/Chicago"),
  timeZone: z.literal("America/Chicago"),
  weekStartDay: z.literal("sunday"),
  timeFormat: z.enum(["12h", "24h"]),
  launched: z.boolean(),
  launchAt: z.string().nullable(),
  pilot: z.boolean(),
  pilotShops: z.array(z.string()),
  closedShopCopy: z.string(),
  shops: z.array(AppConfigShop),
  minVersion: z.object({ ios: z.string(), android: z.string() }),
  forceUpdateBelow: z.object({ ios: z.string(), android: z.string() }),
  minSupportedVersion: z.object({ ios: z.string(), android: z.string() }),
  latestVersion: z.object({ ios: z.string(), android: z.string() }),
  supportPhone: z.string(),
  supportEmail: z.string(),
  privacyUrl: z.string(),
  termsUrl: z.string(),
  deletionUrl: z.string(),
  featureFlags: z.object({ payments: z.boolean(), family: z.boolean(), pushMarketing: z.boolean() }),
});

export const FamilyMember = z.object({
  id: z.string().uuid(),
  guardianId: z.string().uuid(),
  firstName: z.string(),
  birthYear: z.number().int().nullable(),
});
export const FamilyList = z.object({ members: z.array(FamilyMember) });
export const AddFamilyMember = z.object({
  firstName: z.string().min(1).max(60),
  birthYear: z.number().int().optional(),
});
export const FamilyCreated = z.object({ member: FamilyMember });

export const Home = z.object({
  nextAppointment: AppointmentEnvelope.nullable(),
  rebook: z
    .object({ code: z.string(), barberName: z.string(), serviceName: z.string(), weeks: z.number().int() })
    .nullable(),
  loyalty: z.object({
    progressCents: Cents,
    thresholdCents: Cents,
    rewardCents: Cents,
    availableCents: Cents,
    lifetimeEarnedCents: Cents,
    badge: z.null(),
  }),
  family: z.array(FamilyMember),
  favoriteShop: z.object({ slug: z.string(), name: z.string(), waitMinutes: z.number().int() }).nullable(),
});

export const SavedCard = z.object({
  id: z.string(),
  customerId: z.string().uuid(),
  brand: z.string(),
  last4: z.string(),
  funding: z.enum(["credit", "debit", "prepaid", "unknown"]),
  wallet: z.boolean(),
  expMonth: z.number().int().nullable(),
  expYear: z.number().int().nullable(),
});
export const CardList = z.object({ paymentMethods: z.array(SavedCard) });
export const SetupCard = z.object({
  funding: z.enum(["credit", "debit", "prepaid"]).optional(),
  wallet: z.boolean().optional(),
  paymentMethodId: z.string().min(1).optional(),
});
export const SetupCardResponse = z.object({
  paymentMethod: SavedCard.omit({ customerId: true }).nullable(),
  clientSecret: z.string(),
  ephemeralKey: z.string(),
  customerId: z.string(),
});

export const ReceiptSummary = z.object({
  id: z.string().uuid(),
  shopName: z.string(),
  paidAt: z.string().nullable(),
  totalCents: Cents,
  serviceName: z.string().nullable(),
});
export const ReceiptList = z.object({
  receipts: z.array(ReceiptSummary),
  limit: z.number().int(),
  nextCursor: z.string().nullable(),
});
export const CustomerReceipt = z.object({
  id: z.string().uuid(),
  shopName: z.string(),
  serviceName: z.string().nullable(),
  serviceCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  feeCents: Cents,
  feeLabel: z.string().nullable(),
  totalCents: Cents,
  tender: z.string(),
  paidAt: z.string().nullable(),
  grossLabel: z.literal("Gross receipt"),
  settlement: Settlement.nullable(),
  refunds: z.array(RefundRecord),
});
export const ReceiptMissing = z.object({ receipt: z.null() });

export const DeleteStartResponse = z.object({
  consequences: z.array(z.string()),
  devCode: z.string().optional(),
});
export const DeleteConfirm = z.object({ code: z.string().optional() });
export const DeleteConfirmResponse = z.object({ deleted: z.literal(true) });

export const PaymentRequest = z.object({
  paymentMethodId: z.string().optional(),
  tipCents: z.number().int().nonnegative().optional(),
  /** Ignored. Wallet and funding are read from the PaymentMethod (`card.wallet`, `card.funding`). */
  wallet: z.boolean().optional().describe("Ignored. The server reads card.wallet and card.funding from the PaymentMethod."),
  /**
   * Required on POST /payments. The customer app confirms this PaymentIntent in PaymentSheet.
   * A bare paymentMethodId is not charged.
   */
  paymentIntentId: z.string().min(1).optional().describe("PaymentIntent from POST /appointments/{code}/payment-intents. POST /payments records it and ignores a client-sent tip."),
});
export const PaymentIntentSheet = z.object({
  id: z.string(),
  clientSecret: z.string(),
  ephemeralKey: z.string(),
  customerId: z.string(),
  paymentMethodId: z.string(),
  funding: z.enum(["credit", "debit", "prepaid", "unknown"]).nullable(),
  feeCents: Cents,
  totalCents: Cents,
});
export const PaymentPreview = z.object({
  shopId: z.string().uuid(),
  paymentsEnabled: z.boolean(),
  unavailableCopy: z.string().nullable(),
  serviceCents: Cents,
  productCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  funding: z.enum(["credit", "debit", "prepaid", "unknown"]).nullable(),
  wallet: z.boolean(),
  feeCents: Cents,
  feeRate: z.number(),
  feeReason: z.string(),
  feeLabel: z.string().nullable(),
  disclosure: z.string().nullable(),
  totalCents: Cents,
  destination: z.object({
    model: z.literal("separate_charges_and_transfers"),
    shopAccountId: z.string().nullable(),
    serviceTransferCents: Cents,
  }),
  tipTransfer: z.object({
    amountCents: Cents,
    disposition: z.enum(["transfer", "payroll"]),
    copy: z.string().nullable(),
  }),
});
export const PaymentResult = PaymentPreview.extend({
  id: z.string().uuid(),
  paidAt: Instant,
  tender: z.literal("card"),
});

export const LiveWait = z.object({ waitMinutes: z.number().int(), chairsFree: z.number().int() });

export const PurchaseItem = z.object({
  name: z.string(),
  kind: z.string(),
  qty: z.number().int(),
  netCents: Cents,
});
export const Purchase = z.object({
  id: z.string().uuid(),
  paidAt: z.string().nullable(),
  serviceCents: Cents,
  productCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  feeCents: Cents,
  feeLabel: z.string().nullable(),
  totalCents: Cents,
  shop: z.object({ name: z.string(), slug: z.string() }),
  barberFirstName: z.string().nullable(),
  settlement: Settlement.nullable(),
  items: z.array(PurchaseItem),
  refunds: z.array(RefundRecord),
});
export const PurchaseList = z.object({
  purchases: z.array(Purchase),
  lastProduct: z.object({ name: z.string(), purchasedAt: z.string().nullable() }).nullable(),
});
export const PurchaseReceiptBody = z.object({
  id: z.string(),
  number: z.number().int().nullable(),
  paidAt: z.string().nullable(),
  shopName: z.string(),
  serviceCents: Cents,
  productCents: Cents,
  taxCents: Cents,
  tipCents: Cents,
  feeCents: Cents.optional(),
  feeLabel: z.string().nullable().optional(),
  totalCents: Cents,
  barberFirstName: z.string().nullable().optional(),
  settlement: Settlement.nullable().optional(),
  refunds: z.array(
    z.object({
      id: z.string(),
      createdAt: z.string(),
      amountCents: Cents,
      serviceCents: Cents,
      productCents: Cents,
      taxCents: Cents,
      tipCents: Cents,
      feeCents: Cents.optional(),
      shopPortionCents: Cents.nullable().optional(),
      tipPortionCents: Cents.nullable().optional(),
      from: RefundFrom.nullable().optional(),
    }),
  ),
  text: z.string(),
});
export const PurchaseReceipt = z.object({ receipt: PurchaseReceiptBody.nullable() });

export const StaffShop = z.object({ id: z.string().uuid(), slug: z.string(), name: z.string(), tipToBarber: z.boolean() });
export const StaffConnect = z.object({
  signedIn: z.boolean(),
  tipToBarber: z.boolean(),
  firstName: z.string().nullable(),
  shops: z.array(StaffShop),
  account: z
    .object({
      stripeAccountId: z.string(),
      accountType: z.literal("recipient"),
      status: z.enum(["enabled", "restricted", "onboarding", "not_started"]),
      chargesEnabled: z.boolean(),
      payoutsEnabled: z.boolean(),
      detailsSubmitted: z.boolean(),
      mode: z.enum(["simulator", "stripe"]),
    })
    .nullable(),
  transfers: z.array(
    z.object({
      id: z.string(),
      amountCents: Cents,
      status: z.string(),
      createdAt: Instant,
      shop: z.object({ slug: z.string(), name: z.string() }),
    }),
  ),
  schedule: z
    .object({
      interval: z.enum(["manual", "daily", "weekly", "monthly"]),
      delayDays: z.number().nullable(),
      weeklyAnchor: z.string().nullable(),
      monthlyAnchor: z.number().nullable(),
    })
    .nullable(),
});
export const StaffOnboardRequest = z.object({ shop: z.string().min(1).optional() });
export const StaffOnboard = z.object({
  staffId: z.string(),
  stripeAccountId: z.string(),
  url: z.string(),
  mode: z.enum(["simulator", "stripe"]),
  accountType: z.literal("recipient"),
  firstName: z.string(),
  shop: z.object({ id: z.string(), slug: z.string() }),
});
export const ConnectOnboardRequest = z.object({ shop: z.string().min(1) });
export const ConnectOnboard = z.object({ shopId: z.string().uuid(), url: z.string() });

/** Every schema published in the OpenAPI components map. The contract test parses live JSON with these. */
export const apiSchemas = {
  Error: ErrorBody,
  Shop,
  ShopList,
  Service,
  ServiceList,
  Barber,
  BarberList,
  Availability,
  AvailableDays,
  CreateAppointment,
  Appointment,
  AppointmentEnvelope,
  AppointmentList,
  CancelBody,
  RescheduleBody,
  OtpStart,
  OtpStartResponse,
  OtpVerify,
  TokenResponse,
  NeedsProfile,
  ChooseProfile,
  OtpComplete,
  RefreshBody,
  RefreshResponse,
  Me,
  UpdateMe,
  Loyalty,
  RegisterDevice,
  DeviceList,
  DeviceRegistered,
  DeviceRevoked,
  AppConfig,
  Home,
  FamilyList,
  AddFamilyMember,
  FamilyCreated,
  CardList,
  SetupCard,
  SetupCardResponse,
  ReceiptList,
  CustomerReceipt,
  ReceiptMissing,
  DeleteStartResponse,
  DeleteConfirm,
  DeleteConfirmResponse,
  PaymentRequest,
  PaymentIntentSheet,
  PaymentPreview,
  PaymentResult,
  LiveWait,
  PurchaseList,
  PurchaseReceipt,
  StaffConnect,
  StaffOnboardRequest,
  StaffOnboard,
  ConnectOnboardRequest,
  ConnectOnboard,
};
