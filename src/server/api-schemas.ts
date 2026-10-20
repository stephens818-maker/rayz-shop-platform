import { z } from "zod";

/** Request/response schemas for /api/v1. The OpenAPI document is generated from these. */

export const LocalDateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("Local date in America/Chicago, YYYY-MM-DD");
export const Instant = z.string().describe("ISO-8601 instant, e.g. 2026-10-21T15:00:00.000Z");
const Cents = z.number().int().describe("Amount in US cents");

export const ErrorBody = z.object({
  error: z.object({
    code: z.enum(["bad_request", "unauthorized", "forbidden", "not_found", "conflict", "slot_unavailable", "cutoff_passed", "rate_limited", "payment_failed", "internal"]),
    message: z.string(),
    details: z.unknown().nullable(),
  }),
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
  bookingEnabled: z.boolean(),
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
  smsOptIn: z.boolean().optional(),
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
  lastName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  smsOptIn: z.boolean(),
  emailOptIn: z.boolean(),
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
export const NeedsProfile = z.object({ needsProfile: z.literal(true) });
export const RefreshBody = z.object({ refreshToken: z.string() });
export const RefreshResponse = z.object({ accessToken: z.string(), refreshToken: z.string(), tokenType: z.literal("Bearer"), expiresIn: z.number().int() });
export const UpdateMe = z.object({
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().max(60).nullable().optional(),
  email: z.string().email().nullable().optional(),
  smsOptIn: z.boolean().optional(),
  emailOptIn: z.boolean().optional(),
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
