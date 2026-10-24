import { cleanName, lastNamesCompatible, samePerson } from "./customers";

export type DuplicateKind = "likely" | "similar_name" | "same_name" | "shared_contact";

export type DuplicateSignal = "phone" | "email" | "same_name" | "compatible_name" | "similar_name" | "birthday" | "zip" | "phone_last4" | "no_contact";
export type DuplicateConflict = "birthday" | "first_name";

export interface DuplicateSide {
  firstName: string;
  lastName: string | null;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  birthday: string | null;
  zip: string | null;
}

export interface DuplicateScore {
  kind: DuplicateKind;
  score: number;
  signals: DuplicateSignal[];
  conflicts: DuplicateConflict[];
}

/** Edit distance counting a swap of neighbours as one edit (Micheal / Michael). */
export function editDistance(x: string, y: string): number {
  const d = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[x.length][y.length];
}

/**
 * A likely misspelling of the same name: one edit from five letters, two from eight. Short names
 * one letter apart are usually different people (Minh / Linh, Mike / Mika).
 */
export function typoClose(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanName(a);
  const y = cleanName(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const n = Math.min(x.length, y.length);
  const allowed = n >= 8 ? 2 : n >= 5 ? 1 : 0;
  return allowed > 0 && editDistance(x, y) <= allowed;
}

const fullName = (s: DuplicateSide) => `${s.firstName} ${s.lastName ?? ""}`.trim();

/** A typo in the first or last name (or both), never a different first name. */
function similarNames(a: DuplicateSide, b: DuplicateSide): boolean {
  const firsts = (s: DuplicateSide) => [s.firstName, s.nickname].filter(Boolean) as string[];
  const first = firsts(a).some((x) => firsts(b).some((y) => typoClose(x, y) || samePerson({ firstName: x }, { firstName: y })));
  return first && (lastNamesCompatible(a.lastName, b.lastName) || typoClose(a.lastName, b.lastName));
}

/** Mike ~ Michael, and a nickname on file stands in for the first name on either side. */
export function namesMatch(a: DuplicateSide, b: DuplicateSide): boolean {
  const as = [a.firstName, a.nickname].filter(Boolean) as string[];
  const bs = [b.firstName, b.nickname].filter(Boolean) as string[];
  return as.some((x) => bs.some((y) => samePerson({ firstName: x, lastName: a.lastName }, { firstName: y, lastName: b.lastName })));
}

/**
 * How sure we are two records are one person. Contact matches count most; a birthday that differs
 * on both records, or first names that can't be the same person, keep the pair out of "likely"
 * (often a parent and child sharing a number), however much else matches.
 */
export function scoreDuplicate(a: DuplicateSide, b: DuplicateSide): DuplicateScore {
  const signals: DuplicateSignal[] = [];
  const conflicts: DuplicateConflict[] = [];
  let score = 0;
  const add = (s: DuplicateSignal, points: number) => {
    signals.push(s);
    score += points;
  };
  const samePhone = !!a.phone && a.phone === b.phone;
  const sameEmail = !!a.email && a.email === b.email;
  if (samePhone) add("phone", 45);
  if (sameEmail) add("email", 45);

  const exact = cleanName(fullName(a)) === cleanName(fullName(b)) && !!cleanName(a.lastName) && !!cleanName(b.lastName);
  const compatible = namesMatch(a, b);
  const similar = !exact && !compatible && similarNames(a, b);
  if (exact) add("same_name", 35);
  else if (compatible) add("compatible_name", 25);
  else if (similar) add("similar_name", 15);
  else conflicts.push("first_name");

  if (a.birthday && b.birthday) {
    if (a.birthday === b.birthday) add("birthday", 25);
    else {
      conflicts.push("birthday");
      score -= 40;
    }
  }
  if (a.zip && a.zip === b.zip) add("zip", 10);
  if (!samePhone && a.phone && b.phone && a.phone.slice(-4) === b.phone.slice(-4)) add("phone_last4", 10);
  const noContact = (s: DuplicateSide) => !s.phone && !s.email;
  if (noContact(a) || noContact(b)) add("no_contact", 5);

  const nameOk = exact || compatible || similar;
  const contact = samePhone || sameEmail;
  const kind: DuplicateKind = contact
    ? nameOk && !conflicts.includes("birthday")
      ? "likely"
      : "shared_contact"
    : exact || compatible
      ? "same_name"
      : "similar_name";
  return { kind, score: Math.max(0, Math.min(100, score)), signals, conflicts };
}

/**
 * Which record to keep when merging without a person choosing: more completed visits, then the
 * older record (usually the Squire import, with the longer history).
 */
export function pickKeeper<T extends { id: string; visits: number; createdAt: Date }>(a: T, b: T): [keep: T, drop: T] {
  if (a.visits !== b.visits) return a.visits > b.visits ? [a, b] : [b, a];
  if (a.createdAt.getTime() !== b.createdAt.getTime()) return a.createdAt < b.createdAt ? [a, b] : [b, a];
  return a.id < b.id ? [a, b] : [b, a];
}

/**
 * Merge plan for several selected pairs at once. Pairs that share a record chain onto whatever
 * that record was already merged into, so A–B then B–C ends with one client, not a missing one.
 */
export function planMerges<T extends { id: string; visits: number; createdAt: Date }>(pairs: [T, T][]): { keep: string; drop: string }[] {
  const into = new Map<string, string>();
  const root = (id: string): string => {
    let r = id;
    while (into.has(r)) r = into.get(r)!;
    return r;
  };
  const byId = new Map<string, T>();
  const visits = new Map<string, number>();
  for (const c of pairs.flat()) {
    byId.set(c.id, c);
    visits.set(c.id, c.visits);
  }
  const plan: { keep: string; drop: string }[] = [];
  for (const [a, b] of pairs) {
    const ra = byId.get(root(a.id))!;
    const rb = byId.get(root(b.id))!;
    if (ra.id === rb.id) continue;
    const [keep, drop] = pickKeeper({ ...ra, visits: visits.get(ra.id)! }, { ...rb, visits: visits.get(rb.id)! });
    plan.push({ keep: keep.id, drop: drop.id });
    into.set(drop.id, keep.id);
    visits.set(keep.id, visits.get(keep.id)! + visits.get(drop.id)!);
  }
  return plan;
}

export const SIGNAL_LABEL: Record<DuplicateSignal, string> = {
  phone: "phone",
  email: "email",
  same_name: "same name",
  compatible_name: "name (nickname or initial)",
  similar_name: "similar name",
  birthday: "birthday",
  zip: "zip",
  phone_last4: "phone last 4",
  no_contact: "one has no contact",
};
