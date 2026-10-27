import { z } from "zod";
import { STAFF_CHANNELS, STAFF_EVENTS } from "@/domain/staff-notifications";
import { TIP_METHODS } from "@/domain/tips";

/** Request bodies and queries for /api/staff/v1, shared by the handlers and the OpenAPI document. */

const Device = z.string().max(80).nullish().describe("Shown on their sign-ins, e.g. Makenna's iPhone");

export const LoginBody = z.object({ email: z.string().max(200), password: z.string().max(200), deviceName: Device });
export const LoginCodeBody = z.object({ ticket: z.string().max(4000).describe("From the login response's twoFactor"), code: z.string().max(12), deviceName: Device });
export const RefreshBody = z.object({ refreshToken: z.string().min(10).max(200) });

export const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date like 2026-10-27");

export const ScheduleQuery = z.object({
  from: DateStr.optional().describe("First day (shop time); today when left out"),
  days: z.coerce.number().int().min(1).max(62).optional().describe("How many days, 1 to 62; 7 when left out"),
  shopId: z.uuid().optional().describe("One of their shops; all they can reach when left out"),
});

export const AppointmentsQuery = ScheduleQuery.extend({
  status: z.enum(["all", "upcoming", "completed", "missed"]).optional().describe("upcoming, completed, missed (cancelled and no-shows) or all (the default)"),
});

export const IdParam = z.object({ id: z.uuid() });

const Gps = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(100_000).nullable() })
  .nullish()
  .describe("Only where the shop's rule uses location");
const Proof = z
  .object({ qr: z.string().max(64).optional(), tag: z.string().max(64).optional() })
  .optional()
  .describe("The qr or tag from the front-desk QR code's or the NFC sticker's link (/admin/clock?shop=…&qr=… or &tag=…)");
const Photo = z.string().max(400_000).nullish().describe("A data: URL (jpeg, png or webp) where the shop asks for a punch photo; never face-matched");

export const PunchBody = z.object({
  shopId: z.uuid(),
  type: z.enum(["in", "out"]),
  proof: Proof,
  gps: Gps,
  photo: Photo,
  confirmTimeOff: z.boolean().optional().describe("Clock in anyway during time off, after the confirm reply"),
});

export const BreakStartBody = z.object({
  shopId: z.uuid().optional().describe("The shop they're clocked in at when left out"),
  breakReasonId: z.uuid().nullish().describe("From GET /clock breakReasons; none is Break"),
  plannedMin: z.number().int().min(5).max(240).nullish().describe("How long they plan to be; open when left out"),
  proof: Proof,
  gps: Gps,
  photo: Photo,
});

export const BreakEndBody = z.object({ shopId: z.uuid().optional(), proof: Proof, gps: Gps, photo: Photo });

export const PinBody = z.object({ pin: z.string().max(12).describe("4 to 6 digits, not one digit repeated or a run like 1234") });

export const KioskRegisterBody = z.object({ shopId: z.uuid(), label: z.string().max(60).describe("e.g. Front desk iPad") });
export const KioskStatusBody = z.object({ staffId: z.uuid(), pin: z.string().max(12) });
export const KioskPunchBody = KioskStatusBody.extend({
  type: z.enum(["in", "out", "break_start", "break_end"]),
  photo: Photo,
  confirmTimeOff: z.boolean().optional(),
  breakReasonId: z.uuid().nullish(),
  plannedMin: z.number().int().min(5).max(240).nullish(),
});

export const TipsQuery = z.object({ days: z.coerce.number().int().min(1).max(60).optional().describe("History days, 1 to 60; 14 when left out") });
export const EarningsQuery = z.object({ from: DateStr.optional().describe("6 days before `to` when left out"), to: DateStr.optional().describe("Today when left out") });
export const BankingQuery = z.object({ refresh: z.enum(["1", "true"]).optional().describe("Ask Stripe for the latest first, e.g. after coming back from its page") });
export const PayoutMethodBody = z.object({ method: z.enum(TIP_METHODS).nullable().describe("null follows the shop's default"), instant: z.boolean() });

export const SeenBody = z.object({ ids: z.array(z.uuid()).max(50) });

export const DeviceBody = z.object({
  platform: z.enum(["ios", "android"]),
  provider: z.enum(["apns", "fcm", "expo"]),
  token: z.string().min(8).max(4096),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
  pushEnabled: z.boolean().optional(),
});
export const DevicePatch = z.object({
  token: z.string().min(8).max(4096).optional(),
  pushEnabled: z.boolean().optional(),
  appVersion: z.string().max(40).nullish(),
  osVersion: z.string().max(40).nullish(),
});

export const NotificationPrefsBody = z.object({
  events: z.partialRecord(z.enum(STAFF_EVENTS), z.array(z.enum(STAFF_CHANNELS))).describe("confirm, reschedule, cancel, arrived: each to sms, email and/or push"),
  firstHours: z.number().int().optional(),
  secondHours: z.number().int().optional(),
});
