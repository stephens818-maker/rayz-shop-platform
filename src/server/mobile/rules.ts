import { DateTime } from "luxon";
import { SHOP_TZ } from "@/lib/time";

/** Compare dotted numeric versions. Missing parts are 0. Non-numeric suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Account holders must be 13 or older. Birth year alone is enough; January 1 of that year is the earliest birthday. */
export function ageAllowed(birthYear: number, now = new Date()): boolean {
  if (!Number.isInteger(birthYear) || birthYear < 1900 || birthYear > 2100) return false;
  const today = DateTime.fromJSDate(now).setZone(SHOP_TZ);
  const age = today.year - birthYear;
  return age >= 13;
}

/**
 * Marketing messages wait until 8:00 and stop at 21:00 in America/Chicago.
 * Returns the instant to send, or `now` when it is already inside the window.
 * Transactional reminders are not delayed (a 2-hour reminder has to leave on time).
 */
export function nextQuietWindow(now = new Date()): Date {
  const z = DateTime.fromJSDate(now).setZone(SHOP_TZ);
  const minutes = z.hour * 60 + z.minute;
  const open = 8 * 60;
  const close = 21 * 60;
  if (minutes >= open && minutes < close) return now;
  const start = minutes < open ? z.set({ hour: 8, minute: 0, second: 0, millisecond: 0 }) : z.plus({ days: 1 }).set({ hour: 8, minute: 0, second: 0, millisecond: 0 });
  return start.toJSDate();
}

export function inQuietHours(now = new Date()): boolean {
  return nextQuietWindow(now).getTime() !== now.getTime();
}

export type BadgeTier = "gold" | "silver" | "bronze" | "new";

/**
 * Defaults until Charles sets brand thresholds.
 * Gold 12 completed visits, silver 6, bronze 1. Due for a cut after 8 weeks.
 */
export function badgeFor(visits: number, lastCompletedAt: Date | null, now = new Date()): { tier: BadgeTier; label: string; color: string; reason: string; since: string | null } {
  const stale = lastCompletedAt != null && now.getTime() - lastCompletedAt.getTime() >= 56 * 86_400_000;
  const tier: BadgeTier = visits >= 12 ? "gold" : visits >= 6 ? "silver" : visits >= 1 ? "bronze" : "new";
  const label = tier === "gold" ? "Gold" : tier === "silver" ? "Silver" : tier === "bronze" ? "Bronze" : "New";
  if (stale) {
    return { tier, label, color: "#b91c1c", reason: "No completed visit in 8 weeks", since: lastCompletedAt!.toISOString() };
  }
  const color = tier === "gold" ? "#a16207" : tier === "silver" ? "#64748b" : tier === "bronze" ? "#9a3412" : "#334155";
  const reason = tier === "new" ? "No completed visit yet" : `${visits} completed visit${visits === 1 ? "" : "s"}`;
  return { tier, label, color, reason, since: lastCompletedAt?.toISOString() ?? null };
}

/** Fee returned with a refund is the same share of the original fee as the amount refunded is of the original charge. */
export function proportionalFeeCents(originalFeeCents: number, refundedCents: number, originalChargeCents: number): number {
  if (originalFeeCents <= 0 || refundedCents <= 0 || originalChargeCents <= 0) return 0;
  const share = Math.min(1, refundedCents / originalChargeCents);
  return Math.min(originalFeeCents, Math.round(originalFeeCents * share));
}

export const CONSENT_TEXT_VERSION = "2026-10-22";
export const CONSENT_TEXT =
  "Ray'z may text or email you about appointments. Msg & data rates may apply. Reply STOP to opt out, HELP for help. Promotions are a separate choice and are off until you opt in.";

export type ConsentChannel = "sms_transactional" | "sms_marketing" | "email" | "email_marketing" | "push_transactional" | "push_marketing";

/** Imported Squire opt-ins are transactional only. Marketing stays off until a new consent event. */
export function importedConsentChannel(kind: "sms" | "email"): ConsentChannel {
  return kind === "sms" ? "sms_transactional" : "email";
}

const COPY = {
  en: {
    code_invalid: "That code isn't right",
    code_expired: "Code expired. Request a new one.",
    rate_limited: "Too many codes requested. Try again later.",
    upgrade: "Please update the Ray'z app to keep booking.",
    age: "Ray'z accounts are for ages 13 and up. A parent can add you to their profile.",
    email_unverified: "Confirm the new email with the code we sent before it becomes your sign-in.",
    cutoff: "It's inside the cancellation window, so this appointment can't be changed in the app.",
    sunday: "Shops are closed Sundays.",
    fee: "A credit card fee may apply. Debit, prepaid, and wallet payments are not charged the fee.",
  },
  es: {
    code_invalid: "Ese código no es correcto",
    code_expired: "El código venció. Pide uno nuevo.",
    rate_limited: "Pediste demasiados códigos. Inténtalo más tarde.",
    upgrade: "Actualiza la app de Ray'z para seguir reservando.",
    age: "Las cuentas de Ray'z son para mayores de 13 años. Un padre o una madre puede agregarte a su perfil.",
    email_unverified: "Confirma el correo nuevo con el código que enviamos antes de usarlo para entrar.",
    cutoff: "Ya estás dentro del plazo de cancelación, así que la app no puede cambiar esta cita.",
    sunday: "Las barberías cierran los domingos.",
    fee: "Puede haber un cargo en tarjetas de crédito. Débito, prepago y billeteras no pagan ese cargo.",
  },
} as const;

export type CopyKey = keyof (typeof COPY)["en"];

export function localeFromHeader(header: string | null | undefined): "en" | "es" {
  const raw = (header ?? "").toLowerCase();
  return raw.startsWith("es") ? "es" : "en";
}

export function message(locale: "en" | "es", key: CopyKey): string {
  return COPY[locale][key];
}

export function maskEmail(email: string): string {
  const [user, host] = email.split("@");
  if (!host) return "***";
  const head = user.slice(0, 1);
  return `${head}***@${host}`;
}

export function haversineMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.8;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s1 = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s1)));
}
