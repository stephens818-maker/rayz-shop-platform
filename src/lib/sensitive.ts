/**
 * Confidential financial and identity data (card numbers, bank account and routing numbers, SSNs,
 * TINs and EINs, dates of birth for identity checks, ID documents) is collected only by Stripe's own
 * pages and components. This app never asks for it, so it should never arrive; these rules remove it
 * anyway wherever text could carry it: every log line (installLogScrubbing), the audit log, and, in
 * the database, the free-text columns (the same rules in SQL, drizzle/core_0035_scrub_sensitive.sql).
 * Keep the two in step; tests/sensitive.test.ts and tests/db/sensitive-data.test.ts check both.
 */

/** Keys whose value is always removed, after lowercasing and turning anything but letters and digits into "_". */
export const FORBIDDEN_KEY =
  /^(routing(_?(number|no|num))?|aba(_?(number|routing))?|(bank_?)?account_?(number|no|num)|acct_?(number|no|num)|iban|swift(_?code)?|bic|ssn(_?last_?4)?|social_?security(_?number)?|tax_?id(_?number)?|tin|itin|ein|fein|id_?number|personal_?id_?number|dob|date_?of_?birth|birth_?date|card_?(number|no|num)|cc_?(number|num|no)|pan|cvc2?|cvv2?|security_?code|verification_?document|document_?(front|back))$/;

export const normalizeKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "_");
export const isForbiddenKey = (k: string) => FORBIDDEN_KEY.test(normalizeKey(k));

const EDGE = "(?<![0-9A-Za-z_+-])";
const END = "(?![0-9A-Za-z_-])";
/** 13 to 19 digits in a row, or in groups of 4 (or Amex's 4-6-5), starting 2 to 6 as card numbers do. */
const PAN = new RegExp(`${EDGE}(?:[2-6][0-9]{12,18}|[2-6][0-9]{3}(?:[ -][0-9]{4}){2,3}(?:[ -][0-9]{1,3})?|3[47][0-9]{2}[ -][0-9]{6}[ -][0-9]{5})${END}`, "g");
const SSN = new RegExp(`${EDGE}[0-9]{3}([ -])[0-9]{2}\\1[0-9]{4}${END}`, "g");
const EIN = new RegExp(`${EDGE}[0-9]{2}-[0-9]{7}${END}`, "g");

export const REMOVED = { card: "[card number removed]", ssn: "[SSN removed]", ein: "[EIN removed]", key: "[removed]" } as const;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let n = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

const isCardNumber = (m: string) => {
  const d = m.replace(/[^0-9]/g, "");
  return d.length >= 13 && d.length <= 19 && luhn(d);
};

export function scrubText(s: string): string {
  if (!/[0-9]/.test(s)) return s;
  return s
    .replace(PAN, (m) => (isCardNumber(m) ? REMOVED.card : m))
    .replace(SSN, REMOVED.ssn)
    .replace(EIN, REMOVED.ein);
}

const isPlain = (v: object) => {
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};

/** A copy with forbidden keys removed and card, SSN and EIN numbers taken out of every string. Class instances other than errors are left as they are. */
export function scrub<T>(v: T, seen = new WeakMap<object, unknown>()): T {
  if (typeof v === "string") return scrubText(v) as T;
  if ((typeof v === "number" && Number.isInteger(v)) || typeof v === "bigint") return (isCardNumber(String(v)) && /^[2-6][0-9]{12,18}$/.test(String(v)) ? REMOVED.card : v) as T;
  if (!v || typeof v !== "object") return v;
  if (seen.has(v)) return seen.get(v) as T;
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    seen.set(v, out);
    for (const x of v) out.push(scrub(x, seen));
    return out as T;
  }
  if (v instanceof Error) {
    const e = Object.create(Object.getPrototypeOf(v)) as Error;
    seen.set(v, e);
    for (const k of ["name", "message", "stack"] as const) if (typeof v[k] === "string") Object.defineProperty(e, k, { value: scrubText(v[k]!), writable: true, configurable: true });
    for (const [k, x] of Object.entries(v)) (e as unknown as Record<string, unknown>)[k] = isForbiddenKey(k) ? REMOVED.key : scrub(x, seen);
    if ("cause" in v) Object.defineProperty(e, "cause", { value: scrub((v as { cause?: unknown }).cause, seen), writable: true, configurable: true });
    return e as T;
  }
  if (!isPlain(v)) return v;
  const out: Record<string, unknown> = {};
  seen.set(v, out);
  for (const [k, x] of Object.entries(v)) out[k] = isForbiddenKey(k) ? REMOVED.key : scrub(x, seen);
  return out as T;
}

export interface SensitiveFinding {
  path: string;
  why: "forbidden key" | "card number" | "SSN" | "EIN";
}

/** Everything in a value that scrub would remove: a forbidden key (whatever its value) or a card, SSN or EIN number in a string. */
export function findSensitive(v: unknown, path = "$", out: SensitiveFinding[] = [], seen = new WeakSet<object>()): SensitiveFinding[] {
  if (typeof v === "string") {
    if ([...v.matchAll(PAN)].some((m) => isCardNumber(m[0]))) out.push({ path, why: "card number" });
    if (new RegExp(SSN.source).test(v)) out.push({ path, why: "SSN" });
    if (new RegExp(EIN.source).test(v)) out.push({ path, why: "EIN" });
    return out;
  }
  if (typeof v === "number" && scrub(v) !== v) out.push({ path, why: "card number" });
  if (!v || typeof v !== "object" || seen.has(v)) return out;
  seen.add(v);
  for (const [k, x] of Object.entries(v)) {
    if (isForbiddenKey(k)) out.push({ path: `${path}.${k}`, why: "forbidden key" });
    findSensitive(x, `${path}.${k}`, out, seen);
  }
  return out;
}

const INSTALLED = Symbol.for("rayz.logScrubbing");

/** Every console method scrubs its arguments first, so nothing logged (by this app, Next or a library) carries those numbers. */
export function installLogScrubbing(c: Console = console) {
  const target = c as Console & { [INSTALLED]?: true };
  if (target[INSTALLED]) return;
  target[INSTALLED] = true;
  for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    const original = c[m].bind(c);
    c[m] = (...args: unknown[]) => original(...args.map((a) => scrub(a)));
  }
}
