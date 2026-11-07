/**
 * Client search, pure: every way a typed term could identify a client (a name in any order, a phone
 * number in any format or its last 4, an email, a client number or loyalty card, a ticket,
 * appointment, gift card, coupon or Squire ID, a birthday, a town or zip, an address, a note or a
 * tag), and which of those a person may search by.
 *
 * What someone sees of a detail decides how they may search it: seen in full, by any part; masked,
 * only by what the mask already shows (the last 4 of a phone, the town and zip of an address);
 * hidden, only by the exact whole value, matched on its lookup hash. So the search box can't be used
 * to read a hidden value one character at a time.
 */
import { normalizeEmail, normalizePhone } from "@/lib/phone";
import type { ShownBadge } from "./badges";
import type { BuiltinField, Level } from "./client-privacy";

export type Probe =
  /** Words of a name, matched in any order against first, last and nickname, with typos allowed. `last4` narrows by phone. */
  | { kind: "name"; tokens: string[]; text: string; last4?: string }
  | { kind: "phone"; e164: string }
  | { kind: "phone_last4"; digits: string }
  | { kind: "phone_part"; digits: string }
  | { kind: "email"; email: string }
  | { kind: "email_part"; text: string }
  | { kind: "client_id"; id: string }
  | { kind: "client_number"; n: number }
  | { kind: "loyalty_card"; n: number; sig: string }
  | { kind: "ticket"; n: number }
  | { kind: "appointment"; code: string }
  | { kind: "gift_card"; codes: string[] }
  | { kind: "coupon"; code: string }
  | { kind: "squire_id"; id: string }
  | { kind: "birthday"; iso: string }
  | { kind: "birthday_md"; month: number; day: number }
  | { kind: "zip"; zip: string }
  | { kind: "city"; city: string }
  | { kind: "address"; key: string }
  | { kind: "address_part"; text: string }
  | { kind: "notes"; text: string }
  | { kind: "tag"; text: string };
export type ProbeKind = Probe["kind"];

export const PROBE_LABEL: Record<ProbeKind, string> = {
  name: "Name",
  phone: "Phone",
  phone_last4: "Phone ends in",
  phone_part: "Phone",
  email: "Email",
  email_part: "Email",
  client_id: "Client ID",
  client_number: "Client #",
  loyalty_card: "Loyalty card",
  ticket: "Ticket #",
  appointment: "Appointment",
  gift_card: "Gift card",
  coupon: "Coupon code",
  squire_id: "Squire ID",
  birthday: "Birthday",
  birthday_md: "Birthday",
  zip: "Zip",
  city: "Town",
  address: "Address",
  address_part: "Address",
  notes: "Notes",
  tag: "Tag",
};

/**
 * Where a match may come from for someone working in some shops: `exact` reaches any Ray'z client
 * (it identifies one person, so they can be booked anywhere), `scoped` only the searcher's own
 * clients, `ops` only tickets and appointments at the searcher's shops.
 */
export type Reach = "exact" | "scoped" | "ops";

interface ProbeRule {
  reach: Reach;
  /** The detail it reads and the least the searcher must see of it. Absent: it reads nothing protected. */
  needs?: { field: BuiltinField; level: Exclude<Level, "hidden"> };
  /** Order in the results: identifiers first, then names, then the rest. */
  rank: number;
}

export const PROBE_RULES: Record<ProbeKind, ProbeRule> = {
  client_id: { reach: "exact", rank: 100 },
  loyalty_card: { reach: "exact", rank: 100 },
  phone: { reach: "exact", rank: 95 },
  email: { reach: "exact", rank: 95 },
  gift_card: { reach: "exact", rank: 90 },
  coupon: { reach: "exact", rank: 90 },
  squire_id: { reach: "exact", rank: 90 },
  ticket: { reach: "ops", rank: 90 },
  appointment: { reach: "ops", rank: 90 },
  client_number: { reach: "scoped", rank: 90 },
  name: { reach: "scoped", rank: 70 },
  address: { reach: "scoped", rank: 60 },
  birthday: { reach: "scoped", rank: 50 },
  phone_last4: { reach: "scoped", rank: 50, needs: { field: "phone", level: "masked" } },
  phone_part: { reach: "scoped", rank: 45, needs: { field: "phone", level: "full" } },
  email_part: { reach: "scoped", rank: 45, needs: { field: "email", level: "full" } },
  birthday_md: { reach: "scoped", rank: 40, needs: { field: "birthday", level: "full" } },
  address_part: { reach: "scoped", rank: 40, needs: { field: "address", level: "full" } },
  zip: { reach: "scoped", rank: 35, needs: { field: "address", level: "masked" } },
  city: { reach: "scoped", rank: 30, needs: { field: "address", level: "masked" } },
  notes: { reach: "scoped", rank: 25, needs: { field: "notes", level: "full" } },
  tag: { reach: "scoped", rank: 25 },
};

const RANK: Record<Level, number> = { hidden: 0, masked: 1, full: 2 };

/** The readings this person may search by: see the module comment. A name's phone digits need the phone too. */
export function allowedProbes(probes: readonly Probe[], level: (f: BuiltinField) => Level): Probe[] {
  return probes.flatMap((p): Probe[] => {
    const need = PROBE_RULES[p.kind].needs;
    if (need && RANK[level(need.field)] < RANK[need.level]) return [];
    if (p.kind === "name" && p.last4 && level("phone") === "hidden") return [{ ...p, last4: undefined }];
    return [p];
  });
}

// ───────────────────────────── Lookup keys ─────────────────────────────

/** Addresses compared for an exact match: lowercased, every run of other characters one space. Same as the database trigger. */
export const addressKey = (a: string | null | undefined) => {
  const k = (a ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return k || null;
};

/** The normalized value a lookup hash is taken of, or null when the input isn't a whole value. */
export function lookupValue(field: "phone" | "email" | "birthday" | "address", raw: string): string | null {
  switch (field) {
    case "phone":
      return normalizePhone(raw);
    case "email":
      return normalizeEmail(raw);
    case "birthday":
      return parseDate(raw);
    case "address":
      return addressKey(raw);
  }
}

// ───────────────────────────── Reading the term ─────────────────────────────

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** RAYZ1-<client number>-<10-character signature>: what the loyalty QR carries. */
export const LOYALTY_CARD = /^RAYZ1-(\d{5,9})-([A-Z2-7]{10})$/i;
const CODE = /^[A-Za-z0-9][A-Za-z0-9-]{2,39}$/;
export const FIRST_CLIENT_NUMBER = 10001;

/** "1988-07-14", "7/14/1988", "07-14-88" → "1988-07-14". */
export function parseDate(s: string, today = new Date()): string | null {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (r) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t))) {
    [m, d, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
    if (r[3].length === 2) y += y > today.getFullYear() % 100 ? 1900 : 2000;
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 1900) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Words of a name: lowercased, punctuation other than ' and - dropped ("Etting, Jordan" → etting jordan). */
export const nameTokens = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean)
    .slice(0, 6);

function codeProbes(t: string): Probe[] {
  if (!CODE.test(t)) return [];
  const up = t.toUpperCase();
  const bare = up.replace(/-/g, "");
  const gift = [...new Set([up, ...(bare.length === 16 ? [bare.match(/.{4}/g)!.join("-")] : [])])];
  return [
    { kind: "gift_card", codes: gift },
    { kind: "coupon", code: up },
    ...(bare.length === 10 && !up.includes("-") ? [{ kind: "appointment" as const, code: up }] : []),
    { kind: "squire_id", id: t },
  ];
}

const PREFIXES: Record<string, (v: string) => Probe[]> = {
  phone: (v) => digitsProbes(v).filter((p) => p.kind.startsWith("phone")),
  email: (v) => [...(normalizeEmail(v) ? [{ kind: "email" as const, email: normalizeEmail(v)! }] : []), { kind: "email_part", text: v.toLowerCase() }],
  zip: (v) => (/^\d{5}$/.test(v) ? [{ kind: "zip", zip: v }] : []),
  city: (v) => (v ? [{ kind: "city", city: v.toLowerCase().replace(/\s+/g, " ") }] : []),
  town: (v) => PREFIXES.city(v),
  address: (v) => [...(addressKey(v) ? [{ kind: "address" as const, key: addressKey(v)! }] : []), { kind: "address_part", text: v.toLowerCase() }],
  tag: (v) => (v ? [{ kind: "tag", text: v.toLowerCase() }] : []),
  note: (v) => (v.length >= 2 ? [{ kind: "notes", text: v.toLowerCase() }] : []),
  notes: (v) => PREFIXES.note(v),
  ticket: (v) => (/^#?\d{1,9}$/.test(v) ? [{ kind: "ticket", n: Number(v.replace("#", "")) }] : []),
  appt: (v) => (v ? [{ kind: "appointment", code: v.toUpperCase() }] : []),
  appointment: (v) => PREFIXES.appt(v),
  gift: (v) => codeProbes(v).filter((p) => p.kind === "gift_card"),
  coupon: (v) => (v ? [{ kind: "coupon", code: v.toUpperCase() }] : []),
  squire: (v) => (v ? [{ kind: "squire_id", id: v }] : []),
  client: (v) => (/^c?\d{5,9}$/i.test(v) ? [{ kind: "client_number", n: Number(v.replace(/^c/i, "")) }] : []),
  birthday: (v) => dateProbes(v),
  bday: (v) => dateProbes(v),
};

function dateProbes(t: string, today = new Date()): Probe[] {
  const iso = parseDate(t, today);
  if (iso) return [{ kind: "birthday", iso }];
  const md = /^(\d{1,2})[/.-](\d{1,2})$/.exec(t.trim());
  if (md) {
    const [month, day] = [Number(md[1]), Number(md[2])];
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) return [{ kind: "birthday_md", month, day }];
  }
  return [];
}

function digitsProbes(t: string): Probe[] {
  const digits = t.replace(/\D/g, "");
  const out: Probe[] = [];
  const e164 = normalizePhone(t);
  if (e164) out.push({ kind: "phone", e164 });
  if (digits.length === 4) out.push({ kind: "phone_last4", digits });
  else if (digits.length >= 5 && !e164) out.push({ kind: "phone_part", digits });
  return out;
}

/**
 * Every reading of the term. A term with a field prefix ("zip:52241", "tag:vip", "#1234" for a
 * ticket) is read only that way; anything else is read every way it could be.
 */
export function parseSearch(raw: string, today = new Date()): Probe[] {
  const t = raw.trim().replace(/\s+/g, " ").slice(0, 120);
  if (t.length < 2) return [];
  const pre = /^([a-z]+):\s*(.*)$/i.exec(t);
  if (pre && PREFIXES[pre[1].toLowerCase()]) return PREFIXES[pre[1].toLowerCase()](pre[2].trim());
  if (UUID.test(t)) return [{ kind: "client_id", id: t.toLowerCase() }];
  const card = LOYALTY_CARD.exec(t);
  if (card) return [{ kind: "loyalty_card", n: Number(card[1]), sig: card[2].toUpperCase() }];
  if (/^#\d{1,9}$/.test(t)) return [{ kind: "ticket", n: Number(t.slice(1)) }];
  if (/^c\d{5,9}$/i.test(t)) return [{ kind: "client_number", n: Number(t.slice(1)) }];

  const out: Probe[] = [];
  if (t.includes("@") && !t.includes(" ")) {
    const email = normalizeEmail(t);
    if (email) out.push({ kind: "email", email });
    out.push({ kind: "email_part", text: t.toLowerCase() });
    return out;
  }
  const dates = dateProbes(t, today);
  if (dates.length) return dates;

  if (/^[\d\s().+-]+$/.test(t)) {
    const digits = t.replace(/\D/g, "");
    out.push(...digitsProbes(t));
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (digits.length <= 9) out.push({ kind: "ticket", n });
      if (digits.length >= 5 && digits.length <= 9 && n >= FIRST_CLIENT_NUMBER) out.push({ kind: "client_number", n });
      if (digits.length === 5) out.push({ kind: "zip", zip: t });
      out.push({ kind: "squire_id", id: t });
    }
    return out;
  }

  const single = !t.includes(" ");
  const letters = /\p{L}/u.test(t);
  if (single && /\d/.test(t)) out.push(...codeProbes(t));
  if (letters) {
    const trailing = /^(.*\p{L}.*?)\s+(\d{4})$/u.exec(t);
    const tokens = nameTokens(trailing ? trailing[1] : t);
    if (tokens.length) out.push({ kind: "name", tokens, text: tokens.join(" "), ...(trailing ? { last4: trailing[2] } : {}) });
    if (single && !/\d/.test(t)) out.push({ kind: "squire_id", id: t });
    const addressLike = /\d/.test(t) && !single;
    if (addressLike) {
      const key = addressKey(t);
      if (key) out.push({ kind: "address", key });
    }
    if (addressLike || t.length >= 4) out.push({ kind: "address_part", text: t.toLowerCase() });
    if (!/\d/.test(t)) out.push({ kind: "city", city: t.toLowerCase() });
    out.push({ kind: "tag", text: t.toLowerCase() });
    if (t.length >= 3) out.push({ kind: "notes", text: t.toLowerCase() });
  }
  return out;
}

// ───────────────────────────── Results ─────────────────────────────

/** One search result, already as the searcher may see it. */
export interface ClientHit {
  id: string;
  number: number;
  firstName: string;
  lastName: string | null;
  /** "Jordan E." */
  short: string;
  nickname: string | null;
  /** Masked ("***-***-4321"), or null when phones are hidden from the searcher or there's none. */
  phone: string | null;
  /** As the searcher sees emails: masked, full or null. */
  email: string | null;
  notes: string | null;
  lastVisit: { at: string; shop: string | null } | null;
  /** Their preferred barber, or who they see most, as the searcher sees preferred barbers. */
  barber: string | null;
  /** A photo is on file and the searcher sees photos: /admin/customers/{id}/photo. */
  photo: boolean;
  rating: { avg: number; count: number } | null;
  /** Client badges the searcher sees. */
  badges?: ShownBadge[];
  /** How it matched: "Name", "Ticket #1234", "Gift card"... */
  matched: string[];
  /** Family accounts: a child's parent, or a parent's children (age when the searcher sees birthdays). */
  family?: { guardian: { id: string; short: string } | null; kids: { id: string; firstName: string; age: number | null }[] };
}

/** A search result as the pickers list it: the account, with its children underneath. */
export interface FamilyGroup {
  hit: ClientHit;
  /** The parent's children (empty for a child on their own or a client without kids). */
  kids: { id: string; firstName: string; age: number | null; matched: boolean }[];
}

/**
 * Search results as families: a child whose parent is in the results folds under that parent (at
 * the child's place in the ranking, marked as what matched); a child whose parent isn't (out of
 * the searcher's reach) stays a row of their own.
 */
export function groupFamilies(hits: readonly ClientHit[]): FamilyGroup[] {
  const byId = new Map(hits.map((h) => [h.id, h]));
  const folded = new Set(hits.filter((h) => h.family?.guardian && byId.has(h.family.guardian.id)).map((h) => h.id));
  const out: FamilyGroup[] = [];
  const placed = new Set<string>();
  for (const h of hits) {
    const head = folded.has(h.id) ? byId.get(h.family!.guardian!.id)! : h;
    if (placed.has(head.id)) continue;
    placed.add(head.id);
    const kids = head.family?.guardian ? [] : (head.family?.kids ?? []);
    out.push({ hit: head, kids: kids.map((k) => ({ ...k, matched: folded.has(k.id) })) });
  }
  return out;
}

/** "Jordan E.": the first name and last initial, enough to tell clients apart on a shared screen. */
export function shortName(first: string, last: string | null | undefined): string {
  const l = last?.trim();
  return l ? `${first} ${l[0].toUpperCase()}.` : first;
}

/** How a result matched, in words. Never the hidden value itself: the searcher typed whatever it shows. */
export function matchLabel(p: Probe): string {
  switch (p.kind) {
    case "ticket":
      return `Ticket #${p.n}`;
    case "client_number":
      return `Client #${p.n}`;
    case "phone_last4":
      return `Phone ends in ${p.digits}`;
    case "zip":
      return `Zip ${p.zip}`;
    case "tag":
      return `Tag "${p.text}"`;
    case "name":
      return p.last4 ? `Name and phone ending ${p.last4}` : "Name";
    default:
      return PROBE_LABEL[p.kind];
  }
}
