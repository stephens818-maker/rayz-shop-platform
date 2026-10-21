/**
 * A realistic, messy Squire export for import tests and dry runs: a few hundred clients across
 * seven shops, ~1,000 appointment and ticket rows, loyalty and gift cards. Deterministic for a
 * given export date. The people are built first (the ground truth), then written out the way
 * Squire exports them: phone numbers in every format, missing emails, one person with a record at
 * two shops, families sharing a phone, nicknames, walk-in placeholders, former barbers, bad rows.
 *
 * `expected` is derived from that ground truth, not from the importer, so tests can check the
 * importer against it. Regenerate the committed copy with `pnpm tsx scripts/make-squire-fixture.ts`.
 */
import { DateTime } from "luxon";
import { DEFAULT_LOYALTY } from "@/domain/loyalty";

const TZ = "America/Chicago";

type Kind = "clients" | "appointments" | "transactions" | "loyalty" | "gift_cards";
type YesNo = "" | "Yes" | "No";

interface ShopDef {
  name: string;
  area: string;
  barbers: string[];
  /** Weekdays open, Luxon numbering (1 = Monday). */
  days: number[];
}

const SHOPS: ShopDef[] = [
  { name: "Coralville", area: "319", barbers: ["Michelle", "Makenna", "Delaney", "Jessica"], days: [1, 2, 3, 4, 5, 6] },
  { name: "Kimberly", area: "563", barbers: ["Beth", "Sammie", "Maddie", "Ali", "Olivia A"], days: [1, 2, 3, 4, 5, 6] },
  { name: "Le Claire", area: "563", barbers: ["Skylar", "Audra"], days: [2, 3, 4, 5, 6] },
  { name: "Moline", area: "309", barbers: ["Jilane", "Mackenzie", "Jen", "Sara"], days: [1, 2, 3, 4, 5, 6] },
  { name: "Rock Island", area: "309", barbers: ["Garrett", "Mercedez", "Taylor A", "Taylor B"], days: [1, 2, 3, 4, 5, 6] },
  { name: "Silvis", area: "309", barbers: ["Abigail", "Liv", "Amanda"], days: [1, 2, 3, 4, 5, 6] },
  { name: "Utica", area: "563", barbers: ["Sarah", "Kate", "Lindsay", "Em"], days: [1, 2, 3, 4, 5, 6] },
];
/** Barbers who left before cutover: in Squire's history, not on the new staff list. */
const FORMER: Record<string, string> = { Kimberly: "Brittany", Moline: "Destiny" };

const SERVICES: [name: string, cents: number, min: number][] = [
  ["Ray'z Cut w/ Shampoo", 2300, 40],
  ["Ray'z Cut (No Shampoo)", 2000, 20],
  ["Buzz Cut", 1900, 15],
  ["Bald Fade", 1900, 40],
  ["Specialty Fade", 3700, 45],
  ["Kid'z Cut (8th grade & under)", 1800, 20],
  ["Senior / Military Cut", 1800, 20],
  ["Women's Cut", 3500, 40],
];
const ADDONS: [name: string, cents: number, min: number][] = [
  ["Beard Line Up", 500, 5],
  ["Shampoo", 300, 5],
  ["Straight Razor Neck Shave", 300, 5],
];

const FIRST = [
  "Aaron", "Adam", "Aiden", "Andre", "Austin", "Blake", "Brandon", "Brian", "Caleb", "Cameron", "Carlos", "Cody", "Colin", "Connor", "Corey",
  "Derek", "Dominic", "Dylan", "Eli", "Eric", "Ethan", "Evan", "Gabriel", "Grant", "Hunter", "Ian", "Isaac", "Jalen", "Jared", "Jason",
  "Jordan", "Justin", "Kevin", "Kyle", "Landon", "Logan", "Lucas", "Luis", "Marcus", "Mason", "Nathan", "Noah", "Owen", "Parker", "Quinn",
  "Reggie", "Ryan", "Sean", "Seth", "Shane", "Spencer", "Travis", "Trevor", "Tyler", "Victor", "Wesley", "Xavier", "Brooke", "Kayla", "Nora",
];
const LAST = [
  "Anderson", "Bauer", "Becker", "Brooks", "Carlson", "Christensen", "Dietrich", "Engel", "Fischer", "Garcia", "Gonzalez", "Hartman", "Hoffman",
  "Jensen", "Johnson", "Keller", "Klein", "Larson", "Lopez", "Meyer", "Nguyen", "Novak", "Olson", "Peterson", "Ramirez", "Reyes", "Schmidt",
  "Schroeder", "Steiner", "Thompson", "Vogel", "Wagner", "Walsh", "Weber", "Wright", "Yoder", "Zimmerman", "O'Brien", "De La Cruz", "Van Dyke",
];
const NOTES = [
  "#2 on the sides, scissor top",
  "Likes it short for summer",
  "Sensitive skin, no razor",
  'Says "just a trim" but wants it short',
  "Hard part on the left",
  "Brings his own clippers guard, #1.5",
  "Sensory-friendly: quiet chair, no blow dryer",
  "Prefers texts, not calls",
  "Allergic to the lavender shampoo",
  "Usually brings two boys, books back to back",
  "Line up, beard to #3, taper the neck",
  "Pays cash, tips well",
];

/** Squire's export doesn't normalize phones; neither did the people typing them in. */
const PHONE_FORMATS: ((a: string, x: string, l: string) => string)[] = [
  (a, x, l) => `(${a}) ${x}-${l}`,
  (a, x, l) => `${a}-${x}-${l}`,
  (a, x, l) => `${a}${x}${l}`,
  (a, x, l) => `${a}.${x}.${l}`,
  (a, x, l) => `+1 ${a} ${x} ${l}`,
  (a, x, l) => `1-${a}-${x}-${l}`,
  (a, x, l) => ` ${a} ${x}-${l} `,
];

export interface SquireRecord {
  squireId: string;
  shop: string;
  first: string;
  last: string | null;
  phoneRaw: string;
  emailRaw: string;
  sms: YesNo;
  mail: YesNo;
  barber: string;
  since: string;
  notes: string;
}

export type PersonKind = "regular" | "two_shops" | "family" | "same_name" | "no_contact" | "last_name_only" | "bad_phone" | "appointments_only";

export interface FixturePerson {
  key: string;
  kind: PersonKind;
  first: string;
  last: string | null;
  /** E.164, as the app should store it. */
  phone: string | null;
  email: string | null;
  records: SquireRecord[];
  expect: { smsOptIn: boolean; emailOptIn: boolean };
  /** Filled in as visits and tickets are generated. */
  visits: { completed: number; noShows: number; cancelled: number; upcoming: number; visitSpendCents: number; ticketSpendCents: number; tipsCents: number };
  loyalty: { progressCents: number; rewards: number } | null;
}

export interface SquireFixture {
  exportDate: string;
  /** The moment the export was taken; pass as `now` to the importer. */
  now: Date;
  files: Record<Kind, string>;
  people: FixturePerson[];
  expected: {
    clients: { rows: number; created: number; updated: number; merged: number; skipped: Record<string, number> };
    appointments: {
      rows: number;
      imported: number;
      pastVisits: number;
      noShows: number;
      cancellations: number;
      upcoming: number;
      clientsCreated: number;
      formerBarbers: number;
      walkInsWithoutClient: number;
      bookedAtUnknown: number;
      skipped: Record<string, number>;
    };
    transactions: { rows: number; imported: number; voided: number; linked: number; totalCents: number; tipsCents: number; alreadyImported: number; skipped: Record<string, number> };
    loyalty: { rows: number; accounts: number; rewards: number; skipped: Record<string, number> };
    giftCards: { rows: number; imported: number; balanceCents: number; skipped: Record<string, number> };
    /** Distinct real clients after all five files: one per person. */
    clientsTotal: number;
  };
}

function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let x = Math.imul(s ^ (s >>> 15), 1 | s);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const esc = (v: string | number) => {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header: string[], rows: (string | number)[][]) => [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
const dollars = (c: number) => (c / 100).toFixed(2);
const tally = (m: Record<string, number>, k: string) => (m[k] = (m[k] ?? 0) + 1);

export function makeSquireFixture(opts: { exportDate?: string; seed?: number } = {}): SquireFixture {
  const exportDate = opts.exportDate ?? "2026-10-13";
  const rand = rng(opts.seed ?? 20261013);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(rand() * a.length)];
  const chance = (p: number) => rand() < p;
  const exportAt = DateTime.fromISO(`${exportDate}T12:00`, { zone: TZ });
  const shopOf = (name: string) => SHOPS.find((s) => s.name === name)!;

  let phoneSeq = 5000;
  let squireSeq = 20001;
  const newPhone = (area: string) => {
    const l = String(phoneSeq++);
    return { e164: `+1${area}555${l}`, parts: [area, "555", l] as [string, string, string] };
  };
  const fmt = (p: { parts: [string, string, string] } | null) => (p ? pick(PHONE_FORMATS)(...p.parts) : "");
  const emailFor = (first: string, last: string | null, n: number) => `${first}.${(last ?? "x").replace(/[^a-z]/gi, "")}${n}@fixture.test`.toLowerCase();
  const messyEmail = (e: string) => (chance(0.15) ? ` ${e.replace(/^./, (c) => c.toUpperCase()).replace("@fixture.test", "@Fixture.TEST")} ` : e);
  const yn = (pYes: number, pNo: number): YesNo => {
    const r = rand();
    return r < pYes ? "Yes" : r < pYes + pNo ? "No" : "";
  };
  const sinceDate = () => exportAt.minus({ days: 400 + Math.floor(rand() * 2000) }).toFormat("M/d/yyyy");

  const people: FixturePerson[] = [];
  const blankStats = () => ({ completed: 0, noShows: 0, cancelled: 0, upcoming: 0, visitSpendCents: 0, ticketSpendCents: 0, tipsCents: 0 });
  const record = (p: { first: string; last: string | null }, shop: ShopDef, phone: string, email: string, extra: Partial<SquireRecord> = {}): SquireRecord => ({
    squireId: `SQ-${squireSeq++}`,
    shop: shop.name,
    first: p.first,
    last: p.last,
    phoneRaw: phone,
    emailRaw: email,
    sms: yn(0.72, 0.14),
    mail: email ? yn(0.4, 0.3) : "",
    barber: chance(0.65) ? pick(shop.barbers) : "",
    since: sinceDate(),
    notes: chance(0.22) ? pick(NOTES) : "",
    ...extra,
  });
  const consentOf = (recs: SquireRecord[]) => ({
    // The first record sets consent; a later record for the same person can only take it away.
    smsOptIn: recs[0].sms === "Yes" && !recs.slice(1).some((r) => r.sms === "No"),
    emailOptIn: recs[0].mail === "Yes" && !recs.slice(1).some((r) => r.mail === "No"),
  });
  const usedNames = new Set<string>();
  const freshName = () => {
    for (;;) {
      const first = pick(FIRST);
      const last = pick(LAST);
      if (!usedNames.has(`${first} ${last}`)) {
        usedNames.add(`${first} ${last}`);
        return { first, last };
      }
    }
  };

  // Regular clients, one Squire record each.
  for (let i = 0; i < 150; i++) {
    const shop = pick(SHOPS);
    const name = freshName();
    const phone = chance(0.93) ? newPhone(shop.area) : null;
    const email = chance(0.58) ? emailFor(name.first, name.last, i) : null;
    const rec = record(name, shop, fmt(phone), email ? messyEmail(email) : "");
    if (rec.barber === "" && chance(0.08) && FORMER[shop.name]) rec.barber = FORMER[shop.name];
    people.push({ key: `regular-${i}`, kind: phone || email ? "regular" : "no_contact", ...name, phone: phone?.e164 ?? null, email, records: [rec], expect: consentOf([rec]), visits: blankStats(), loyalty: null });
  }

  // The same person at two shops: two Squire records, two Squire IDs, one client here.
  const twoShopNames: [string, string, string][] = [
    ["Mike", "Michael", "Hansen"],
    ["Chris", "Christopher", "Duffy"],
    ["Alex", "Alexander", "Moreno"],
    ["Bill", "William", "Kowalczyk"],
    ["Joe", "Joseph", "Russo"],
    ["Tony", "Anthony", "Bianchi"],
    ["Dan", "Daniel", "Ostrowski"],
    ["Jake", "Jacob", "Lindqvist"],
    ["Matt", "Matthew", "Sorensen"],
    ["Nick", "Nicholas", "Papadakis"],
    ["Zach", "Zachary", "Holm"],
    ["Ben", "Benjamin", "Achebe"],
  ];
  twoShopNames.forEach(([nick, full, last], i) => {
    const [a, b] = [SHOPS[i % SHOPS.length], SHOPS[(i + 3) % SHOPS.length]];
    const phone = newPhone(a.area);
    const email = emailFor(full, last, 900 + i);
    const variant = i % 4;
    // 0: same phone (different format), second record has no email
    // 1: same email, second record has a newer phone
    // 2: nickname on one record, full name on the other, same phone
    // 3: same phone; the second record opted out of texts
    const r1 = record({ first: variant === 2 ? nick : full, last }, a, fmt(phone), email, { sms: "Yes", mail: "Yes" });
    const r2 = record(
      { first: variant === 2 ? full : i % 2 ? nick : full, last: variant === 0 ? null : last },
      b,
      variant === 1 ? fmt(newPhone(b.area)) : fmt(phone),
      variant === 0 ? "" : email.toUpperCase(),
      { sms: variant === 3 ? "No" : "", mail: variant === 3 ? "No" : "" },
    );
    people.push({ key: `two-shops-${i}`, kind: "two_shops", first: r1.first, last, phone: phone.e164, email, records: [r1, r2], expect: consentOf([r1, r2]), visits: blankStats(), loyalty: null });
  });

  // Families: a parent and a kid on one phone. Different people, so two clients.
  const families: [string, string, string][] = [
    ["Kevin", "Tyler", "Brandt"],
    ["Marcus", "Jaylen", "Freeman"],
    ["Nora", "Owen", "Lindgren"],
    ["Brooke", "Mason", "Kerr"],
    ["Derek", "Eli", "Pham"],
    ["Kayla", "Landon", "Sisk"],
  ];
  families.forEach(([parent, kid, last], i) => {
    const shop = SHOPS[(i * 2) % SHOPS.length];
    const phone = newPhone(shop.area);
    const email = emailFor(parent, last, 950 + i);
    const rp = record({ first: parent, last }, shop, fmt(phone), email);
    const rk = record({ first: kid, last }, shop, fmt(phone), "", { notes: `Parent: ${parent}` });
    people.push({ key: `family-${i}-parent`, kind: "family", first: parent, last, phone: phone.e164, email, records: [rp], expect: consentOf([rp]), visits: blankStats(), loyalty: null });
    people.push({ key: `family-${i}-kid`, kind: "family", first: kid, last, phone: phone.e164, email: null, records: [rk], expect: consentOf([rk]), visits: blankStats(), loyalty: null });
  });

  // Same name, different people (different contact at different shops): never merged.
  for (const [i, [first, last]] of ([["Chris", "Miller"], ["Ryan", "Schultz"], ["Tyler", "Johnson"]] as const).entries()) {
    for (const j of [0, 1]) {
      const shop = SHOPS[(i + j * 4) % SHOPS.length];
      const phone = newPhone(shop.area);
      const email = j === 0 ? emailFor(first, last, 970 + i) : null;
      const rec = record({ first, last }, shop, fmt(phone), email ?? "");
      people.push({ key: `same-name-${i}-${j}`, kind: "same_name", first, last, phone: phone.e164, email, records: [rec], expect: consentOf([rec]), visits: blankStats(), loyalty: null });
    }
  }

  // Squire quirks that still are real clients.
  {
    const shop = shopOf("Kimberly");
    const phone = newPhone(shop.area);
    const rec = record({ first: "", last: "Okafor" }, shop, fmt(phone), "");
    people.push({ key: "last-name-only", kind: "last_name_only", first: "Okafor", last: null, phone: phone.e164, email: null, records: [rec], expect: consentOf([rec]), visits: blankStats(), loyalty: null });
    const email = emailFor("Hector", "Salinas", 990);
    const bad = record({ first: "Hector", last: "Salinas" }, shopOf("Moline"), "call the shop", email);
    people.push({ key: "bad-phone", kind: "bad_phone", first: "Hector", last: "Salinas", phone: null, email, records: [bad], expect: consentOf([bad]), visits: blankStats(), loyalty: null });
  }

  // ── clients.csv ──
  const clientRows: (string | number)[][] = [];
  const toRow = (r: SquireRecord) => [r.squireId, r.first, r.last ?? "", r.phoneRaw, r.emailRaw, r.shop, r.barber, r.since, r.sms, r.mail, r.notes];
  const allRecords = people.flatMap((p) => p.records.map((r, idx) => ({ p, r, idx })));
  // Squire sorts by client ID; second records were created later, so they come later.
  allRecords.sort((x, y) => x.r.squireId.localeCompare(y.r.squireId));
  const clientsSkipped: Record<string, number> = {};
  let clientsUpdated = 0;
  const dupRowsAt = new Set([40, 110]);
  allRecords.forEach(({ r }, i) => {
    clientRows.push(toRow(r));
    if (dupRowsAt.has(i)) {
      // Exported twice (Squire does this when a profile was edited during the export).
      clientRows.push(toRow(r));
      clientsUpdated++;
    }
    if (i === 20) {
      clientRows.push([`SQ-${squireSeq++}`, "", "", "563-555-4999", "", "Kimberly", "", "", "", "", "Deleted profile"]);
      tally(clientsSkipped, "Missing name");
    }
    if (i === 75) {
      // Squire's walk-in placeholder profile.
      clientRows.push([`SQ-${squireSeq++}`, "Walk", "In", "", "", "Coralville", "", "", "", "", ""]);
      tally(clientsSkipped, "Placeholder client");
    }
    if (i === 130) {
      clientRows.push([`SQ-${squireSeq++}`, "", "", "", "", "Moline", "", "", "", "", ""]);
      tally(clientsSkipped, "Missing name");
    }
  });
  const clientsCsv = csv(["Client ID", "First Name", "Last Name", "Phone", "Email", "Location", "Preferred Barber", "Client Since", "SMS Opt In", "Email Marketing", "Notes"], clientRows);
  const twoShopCount = people.filter((p) => p.records.length > 1).length;
  const clientsFromFile = people.length;

  // ── appointments.csv ──
  type Visit = {
    id: string;
    at: DateTime;
    shop: ShopDef;
    barber: string;
    person: FixturePerson | null;
    rec: SquireRecord | null;
    status: "Checked Out" | "No Show" | "Cancelled" | "Booked" | "Confirmed";
    services: [string, number, number];
    addon: [string, number, number] | null;
    priceCents: number;
    bookedAt: string;
    idInExport: boolean;
    label?: string;
  };
  const visits: Visit[] = [];
  const busy = new Set<string>();
  let apptSeq = 500001;
  const slot = (shop: ShopDef, barber: string, from: number, to: number): DateTime => {
    for (;;) {
      const day = exportAt.startOf("day").plus({ days: from + Math.floor(rand() * (to - from)) });
      if (!shop.days.includes(day.weekday)) continue;
      // On the hour for upcoming bookings so one barber's bookings can never overlap.
      const at = day.set({ hour: 9 + Math.floor(rand() * 8), minute: from > 0 ? 0 : pick([0, 30]) });
      const key = `${barber}|${at.toISO()}`;
      const hour = `${barber}|${at.toISODate()}|${at.hour}`;
      if (busy.has(key) || busy.has(hour)) continue;
      busy.add(key);
      busy.add(hour);
      return at;
    }
  };
  const priceOf = (svc: [string, number, number], addon: [string, number, number] | null) => svc[1] + (addon?.[1] ?? 0);
  const addVisit = (v: Omit<Visit, "id" | "services" | "addon" | "priceCents" | "bookedAt" | "idInExport"> & Partial<Visit>) => {
    const services = v.services ?? pick(SERVICES.slice(0, 7));
    const addon = v.addon === undefined ? (chance(0.2) ? pick(ADDONS) : null) : v.addon;
    const bookedAt = v.bookedAt ?? (chance(0.7) ? v.at.minus({ days: 1 + Math.floor(rand() * 20) }).toFormat("M/d/yyyy h:mm a") : "");
    const full: Visit = { id: `SQA-${apptSeq++}`, services, addon, priceCents: priceOf(services, addon), bookedAt, idInExport: true, ...v } as Visit;
    visits.push(full);
    return full;
  };

  for (const p of people) {
    for (const rec of p.records) {
      const shop = shopOf(rec.shop);
      const n = p.kind === "no_contact" ? 1 : Math.floor(rand() * 7);
      const usual = rec.barber && rec.barber !== FORMER[shop.name] ? rec.barber : pick(shop.barbers);
      for (let k = 0; k < n; k++) {
        const r = rand();
        const status = r < 0.07 ? "No Show" : r < 0.15 ? "Cancelled" : "Checked Out";
        const former = FORMER[shop.name] && chance(0.12);
        const barber = former ? FORMER[shop.name] : chance(0.75) ? usual : pick(shop.barbers);
        // One completed visit per person per day keeps ticket-to-visit linking unambiguous.
        let at = slot(shop, barber, -540, -1);
        while (visits.some((v) => v.person === p && v.at.hasSame(at, "day"))) at = slot(shop, barber, -540, -1);
        addVisit({ at, shop, barber, person: p, rec, status });
      }
    }
  }
  // Every former barber has history, so they exist before any upcoming row names them.
  for (const [shopName, barber] of Object.entries(FORMER)) {
    const p = people.find((x) => x.kind === "regular" && x.records[0].shop === shopName)!;
    const shop = shopOf(shopName);
    let at = slot(shop, barber, -400, -300);
    while (visits.some((v) => v.person === p && v.at.hasSame(at, "day"))) at = slot(shop, barber, -400, -300);
    addVisit({ at, shop, barber, person: p, rec: p.records[0], status: "Checked Out" });
  }
  // Upcoming bookings 30-75 days out, always with a current barber.
  const upcomingPeople = people.filter((p) => p.kind === "regular" || p.kind === "two_shops").filter((_, i) => i % 6 === 0);
  for (const p of upcomingPeople) {
    const rec = p.records[p.records.length - 1];
    const shop = shopOf(rec.shop);
    const barber = rec.barber && shop.barbers.includes(rec.barber) ? rec.barber : pick(shop.barbers);
    addVisit({ at: slot(shop, barber, 30, 75), shop, barber, person: p, rec, status: chance(0.5) ? "Booked" : "Confirmed" });
  }
  // Squire's walk-in placeholder: a visit, not a client.
  const walkIns: Visit[] = [];
  for (let k = 0; k < 12; k++) {
    const shop = pick(SHOPS);
    const barber = pick(shop.barbers);
    walkIns.push(addVisit({ at: slot(shop, barber, -200, -1), shop, barber, person: null, rec: null, status: "Checked Out", bookedAt: "", label: "Walk In" }));
  }
  // A first name only, no ID or contact: kept on the visit, no client created.
  const nameOnly: Visit[] = [];
  for (const nm of ["Jake", "Big Mike", "Coach"]) {
    const shop = pick(SHOPS);
    const barber = pick(shop.barbers);
    nameOnly.push(addVisit({ at: slot(shop, barber, -300, -1), shop, barber, person: null, rec: null, status: "Checked Out", bookedAt: "", label: nm }));
  }
  // A client who only appears in the appointments export (added after the client report was pulled).
  const lateClient: FixturePerson = {
    key: "appointments-only",
    kind: "appointments_only",
    first: "Tobias",
    last: "Wendt",
    phone: null,
    email: null,
    records: [],
    expect: { smsOptIn: false, emailOptIn: false },
    visits: blankStats(),
    loyalty: null,
  };
  {
    const shop = shopOf("Utica");
    const phone = newPhone(shop.area);
    lateClient.phone = phone.e164;
    const rec: SquireRecord = { squireId: `SQ-${squireSeq++}`, shop: shop.name, first: "Tobias", last: "Wendt", phoneRaw: fmt(phone), emailRaw: "", sms: "", mail: "", barber: "", since: "", notes: "" };
    lateClient.records.push(rec);
    for (const d of [-20, -5]) {
      const barber = shop.barbers[0];
      addVisit({ at: slot(shop, barber, d, d + 1), shop, barber, person: lateClient, rec, status: "Checked Out" });
    }
    people.push(lateClient);
  }
  // Visits booked online without a Squire account: no client ID, matched by phone and name.
  const byPhoneOnly = visits.filter((v) => v.person && v.person.phone && (v.person.kind === "regular" || v.person.kind === "family") && v.status === "Checked Out").filter((_, i) => i % 25 === 3);

  // Bad rows (each skipped with a reason).
  const apptSkipped: Record<string, number> = {};
  const badAppt: (string | number)[][] = [];
  const badRow = (reason: string, row: (string | number)[]) => {
    badAppt.push(row);
    tally(apptSkipped, reason);
  };
  const someone = people.find((p) => p.kind === "regular" && p.phone)!;
  const r0 = someone.records[0];
  const base = (over: Partial<Record<string, string>>) => {
    const d = { id: `SQA-${apptSeq++}`, date: "3/14/2026", time: "10:00 AM", shop: r0.shop, barber: shopOf(r0.shop).barbers[0], cid: r0.squireId, name: `${r0.first} ${r0.last}`, phone: r0.phoneRaw, email: "", svc: "Buzz Cut", addons: "", price: "19.00", dur: "15", status: "Checked Out", booked: "", ...over };
    return [d.id, d.date, d.time, d.shop, d.barber, d.cid, d.name, d.phone, d.email, d.svc, d.addons, d.price, d.dur, d.status, d.booked];
  };
  badRow("Unknown shop", base({ shop: "Clinton" }));
  badRow("Unknown shop", base({ shop: "Clinton", date: "4/2/2026" }));
  badRow("Bad date", base({ date: "TBD", time: "" }));
  badRow("Missing barber", base({ barber: "", date: "5/9/2026" }));
  badRow("Ambiguous barber", base({ shop: "Rock Island", barber: "Taylor", date: "6/1/2026" }));
  badRow("Ambiguous barber", base({ shop: "Rock Island", barber: "Taylor", date: "6/8/2026", time: "1:30 PM" }));
  const futureWithFormer = exportAt.plus({ days: 40 });
  badRow(
    "Inactive barber",
    base({ shop: "Kimberly", barber: "Brittany", date: futureWithFormer.toFormat("M/d/yyyy"), time: "11:00 AM", status: "Booked", cid: "", name: "Owen Brandt", phone: "" }),
  );

  const apptHeader = ["Appointment ID", "Date", "Time", "Location", "Barber", "Client ID", "Client Name", "Phone", "Email", "Services", "Add-ons", "Price", "Duration", "Status", "Booked At"];
  const visitRow = (v: Visit) => {
    const phoneOnly = byPhoneOnly.includes(v);
    const r = v.rec;
    return [
      v.id,
      v.at.toFormat("M/d/yyyy"),
      v.at.toFormat("h:mm a"),
      v.shop.name,
      v.barber,
      r && !phoneOnly ? r.squireId : "",
      r ? `${r.first || r.last} ${r.first ? (r.last ?? "") : ""}`.trim() : (v.label ?? ""),
      r ? (phoneOnly ? fmt({ parts: [v.person!.phone!.slice(2, 5), v.person!.phone!.slice(5, 8), v.person!.phone!.slice(8)] }) : r.phoneRaw) : "",
      r && chance(0.3) ? r.emailRaw.trim() : "",
      v.services[0],
      v.addon?.[0] ?? "",
      dollars(v.priceCents),
      v.services[2] + (v.addon?.[2] ?? 0),
      v.status,
      v.bookedAt,
    ];
  };
  // Squire sorts by date; history first, so a former barber exists before any future row names them.
  const sorted = [...visits].sort((a, b) => a.at.toMillis() - b.at.toMillis());
  const apptRows = sorted.map(visitRow);
  const futureIdx = sorted.findIndex((v) => v.at > exportAt);
  apptRows.splice(futureIdx < 0 ? apptRows.length : futureIdx, 0, ...badAppt.slice(0, 6));
  apptRows.push(badAppt[6]);
  const appointmentsCsv = csv(apptHeader, apptRows);

  for (const v of visits) {
    if (!v.person) continue;
    const s = v.person.visits;
    if (v.status === "Checked Out") s.completed++;
    else if (v.status === "No Show") s.noShows++;
    else if (v.status === "Cancelled") s.cancelled++;
    else s.upcoming++;
  }

  // ── transactions.csv ──
  const txHeader = ["Transaction ID", "Appointment ID", "Date", "Time", "Location", "Barber", "Client ID", "Client Name", "Services", "Products", "Tip", "Tax", "Discount", "Total", "Payment Method", "Status"];
  const txRows: (string | number)[][] = [];
  const txSkipped: Record<string, number> = {};
  let txSeq = 700001;
  let txImported = 0;
  let txVoided = 0;
  let txLinked = 0;
  let txTotal = 0;
  let txTips = 0;
  const ticketed = new Set<Visit>();
  const completed = sorted.filter((v) => v.status === "Checked Out");
  for (const v of completed) {
    if (!chance(0.88)) continue;
    ticketed.add(v);
    const discount = chance(0.05) ? 300 : 0;
    const service = v.priceCents - discount;
    const product = chance(0.1) ? pick([1800, 2200, 2800]) : 0;
    const tax = Math.round(product * 0.07);
    const tip = pick([0, 0, 300, 400, 500, 500, 600, 800, 1000]);
    const total = service + product + tax + tip;
    const voided = chance(0.025);
    const withApptId = !v.person || chance(0.8);
    const end = v.at.plus({ minutes: v.services[2] + (v.addon?.[2] ?? 0) });
    const r = v.rec;
    txRows.push([
      `SQT-${txSeq++}`,
      withApptId ? v.id : "",
      end.toFormat("M/d/yyyy"),
      end.toFormat("h:mm a"),
      v.shop.name,
      v.barber,
      r?.squireId ?? "",
      r ? `${r.first || r.last} ${r.first ? (r.last ?? "") : ""}`.trim() : (v.label ?? ""),
      dollars(service),
      product ? dollars(product) : "",
      dollars(tip),
      dollars(tax),
      discount ? `(${dollars(discount)})` : "",
      dollars(total),
      pick(["Visa", "Mastercard", "Cash", "Cash", "Amex", "Discover", "Gift Card"]),
      voided ? "Refunded" : "Paid",
    ]);
    if (voided) txVoided++;
    else {
      txImported++;
      txTotal += total;
      txTips += tip;
      // Linked by appointment ID, or by client + shop + day for rows without one.
      if (withApptId || v.person) txLinked++;
      if (v.person) {
        v.person.visits.ticketSpendCents += service + product;
        v.person.visits.tipsCents += tip;
      }
    }
  }
  // Retail-only tickets on days without a visit.
  const retailBuyers = people.filter((p) => p.kind === "regular" && p.visits.completed > 0).slice(0, 8);
  for (const p of retailBuyers) {
    const rec = p.records[0];
    const shop = shopOf(rec.shop);
    let day: DateTime;
    do day = slot(shop, "retail", -300, -2);
    while (visits.some((v) => v.person === p && v.at.hasSame(day, "day")));
    const product = pick([1800, 2200, 2800]);
    const tax = Math.round(product * 0.07);
    txRows.push([`SQT-${txSeq++}`, "", day.toFormat("M/d/yyyy"), day.toFormat("h:mm a"), shop.name, "", rec.squireId, `${rec.first} ${rec.last ?? ""}`.trim(), "0.00", dollars(product), "0.00", dollars(tax), "", dollars(product + tax), "Visa", "Paid"]);
    txImported++;
    txTotal += product + tax;
    p.visits.ticketSpendCents += product;
  }
  // Bad and duplicate rows.
  const dupOf = txRows[30];
  txRows.splice(31, 0, [...dupOf]);
  const alreadyImported = 1;
  const badTx = (reason: string, row: (string | number)[]) => {
    txRows.push(row);
    tally(txSkipped, reason);
  };
  badTx("Unknown shop", [`SQT-${txSeq++}`, "", "2/3/2026", "2:00 PM", "Clinton", "", "", "", "20.00", "", "0.00", "0.00", "", "20.00", "Cash", "Paid"]);
  badTx("Bad amount", [`SQT-${txSeq++}`, "", "2/4/2026", "2:00 PM", "Moline", "", "", "", "", "", "", "", "", "", "Cash", "Paid"]);
  badTx("Bad amount", [`SQT-${txSeq++}`, "", "2/5/2026", "2:00 PM", "Moline", "", "", "", "(20.00)", "", "0.00", "0.00", "", "(20.00)", "Visa", "Refund"]);
  badTx("Bad date", [`SQT-${txSeq++}`, "", "02/30/2026", "2:00 PM", "Moline", "", "", "", "20.00", "", "0.00", "0.00", "", "20.00", "Visa", "Paid"]);
  const transactionsCsv = csv(txHeader, txRows);

  for (const v of completed) if (v.person && !ticketed.has(v)) v.person.visits.visitSpendCents += v.priceCents;

  // ── loyalty.csv ──
  const loyHeader = ["Client ID", "Client Name", "Phone", "Email", "Progress", "Rewards Available"];
  const loyRows: (string | number)[][] = [];
  const loySkipped: Record<string, number> = {};
  const loyalty = new Map<FixturePerson, { progress: number; rewards: number }>();
  for (const p of people) {
    if (p.kind === "appointments_only") continue;
    const all = p.kind === "two_shops";
    for (const rec of all ? p.records : p.records.slice(0, 1)) {
      if (!all && !chance(0.6)) continue;
      const progress = all ? 16_000 + Math.floor(rand() * 10_000) : Math.floor(rand() * 29_000);
      const rewards = chance(0.15) ? 1 : 0;
      loyRows.push([rec.squireId, `${rec.first || rec.last} ${rec.first ? (rec.last ?? "") : ""}`.trim(), rec.phoneRaw, rec.emailRaw, `$${dollars(progress)}`, rewards]);
      const prior = loyalty.get(p) ?? { progress: 0, rewards: 0 };
      loyalty.set(p, { progress: prior.progress + progress, rewards: prior.rewards + rewards });
    }
  }
  loyRows.push(["SQ-99001", "Ghost Client", "3095550001", "", "$40.00", "0"]);
  tally(loySkipped, "No matching client");
  loyRows.push(["SQ-99002", "", "", "nobody@fixture.test", "$12.00", "0"]);
  tally(loySkipped, "No matching client");
  const neg = people.find((p) => p.kind === "regular" && !loyalty.has(p))!;
  loyRows.push([neg.records[0].squireId, neg.first, "", "", "($5.00)", "0"]);
  tally(loySkipped, "Bad amount");
  let loyaltyRewards = 0;
  for (const [p, l] of loyalty) {
    let progress = l.progress;
    let rewards = l.rewards;
    while (progress >= DEFAULT_LOYALTY.thresholdCents) {
      progress -= DEFAULT_LOYALTY.thresholdCents;
      rewards++;
    }
    p.loyalty = { progressCents: progress, rewards };
    loyaltyRewards += rewards;
  }
  const loyaltyCsv = csv(loyHeader, loyRows);

  // ── gift_cards.csv ──
  const gcHeader = ["Code", "Original Amount", "Remaining Balance", "Client ID", "Client Name", "Expires"];
  const gcRows: (string | number)[][] = [];
  const gcSkipped: Record<string, number> = {};
  let gcBalance = 0;
  for (let k = 0; k < 18; k++) {
    const initial = pick([2500, 5000, 5000, 10000]);
    const balance = k % 6 === 5 ? 0 : Math.round((initial * Math.floor(rand() * 100)) / 100);
    const owner = k % 3 === 0 ? people[k * 5].records[0] : null;
    gcRows.push([`SQGC-${3000 + k}`, `$${dollars(initial)}`, `$${dollars(balance)}`, owner?.squireId ?? "", owner ? `${owner.first} ${owner.last ?? ""}`.trim() : "", k % 4 === 0 ? exportAt.plus({ years: 1 }).toFormat("M/d/yyyy") : ""]);
    gcBalance += balance;
  }
  gcRows.push(["", "$25.00", "$25.00", "", "", ""]);
  tally(gcSkipped, "Missing code");
  gcRows.push(["SQGC-3999", "$25.00", "n/a", "", "", ""]);
  tally(gcSkipped, "Bad amount");
  const giftCardsCsv = csv(gcHeader, gcRows);

  const pastVisits = visits.filter((v) => v.status === "Checked Out").length;
  return {
    exportDate,
    now: exportAt.toJSDate(),
    files: { clients: clientsCsv, appointments: appointmentsCsv, transactions: transactionsCsv, loyalty: loyaltyCsv, gift_cards: giftCardsCsv },
    people,
    expected: {
      clients: {
        rows: clientRows.length,
        created: clientsFromFile,
        updated: clientsUpdated,
        merged: twoShopCount,
        skipped: clientsSkipped,
      },
      appointments: {
        rows: apptRows.length,
        imported: visits.length,
        pastVisits,
        noShows: visits.filter((v) => v.status === "No Show").length,
        cancellations: visits.filter((v) => v.status === "Cancelled").length,
        upcoming: visits.filter((v) => v.status === "Booked" || v.status === "Confirmed").length,
        clientsCreated: 1,
        formerBarbers: new Set(visits.filter((v) => Object.values(FORMER).includes(v.barber)).map((v) => v.barber)).size,
        walkInsWithoutClient: walkIns.length + nameOnly.length,
        bookedAtUnknown: visits.filter((v) => !v.bookedAt).length,
        skipped: apptSkipped,
      },
      transactions: { rows: txRows.length, imported: txImported, voided: txVoided, linked: txLinked, totalCents: txTotal, tipsCents: txTips, alreadyImported, skipped: txSkipped },
      loyalty: { rows: loyRows.length, accounts: loyalty.size, rewards: loyaltyRewards, skipped: loySkipped },
      giftCards: { rows: gcRows.length, imported: 18, balanceCents: gcBalance, skipped: gcSkipped },
      clientsTotal: people.length,
    },
  };
}
