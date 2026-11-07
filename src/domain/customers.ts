/**
 * Who is the same person? One rule set, used by booking, sign-in, the Squire importer, and the
 * duplicates page. A shared phone or email alone is not enough: families share both, so the first
 * names must be compatible too, and the last names must not contradict each other.
 */

const NICKNAMES: string[][] = [
  ["michael", "mike", "mikey", "mick"],
  ["matthew", "matt"],
  ["christopher", "chris", "topher"],
  ["nicholas", "nick", "nicky", "nico"],
  ["alexander", "alex", "xander", "al"],
  ["alexandra", "alex", "lexi", "alexa"],
  ["anthony", "tony"],
  ["joseph", "joe", "joey"],
  ["james", "jim", "jimmy", "jamie"],
  ["william", "will", "bill", "billy", "liam"],
  ["robert", "rob", "bob", "bobby", "robbie"],
  ["richard", "rich", "rick", "ricky", "dick"],
  ["daniel", "dan", "danny"],
  ["david", "dave", "davey"],
  ["steven", "steve", "stevie"],
  ["stephen", "steve", "stevie"],
  ["thomas", "tom", "tommy"],
  ["john", "johnny", "jack"],
  ["jonathan", "jon", "jonny"],
  ["benjamin", "ben", "benny"],
  ["samuel", "sam", "sammy"],
  ["samantha", "sam", "sammy"],
  ["jacob", "jake"],
  ["joshua", "josh"],
  ["zachary", "zach", "zack"],
  ["andrew", "andy", "drew"],
  ["timothy", "tim", "timmy"],
  ["edward", "ed", "eddie", "ted"],
  ["gregory", "greg"],
  ["jeffrey", "jeff"],
  ["kenneth", "ken", "kenny"],
  ["lawrence", "larry"],
  ["patrick", "pat"],
  ["ronald", "ron", "ronnie"],
  ["donald", "don", "donnie"],
  ["raymond", "ray"],
  ["gerald", "gerry", "jerry"],
  ["charles", "charlie", "chuck"],
  ["frederick", "fred", "freddie"],
  ["elizabeth", "liz", "beth", "betsy", "lizzie", "eliza"],
  ["katherine", "kate", "katie", "kathy", "kat"],
  ["catherine", "cathy", "cat", "kate"],
  ["jennifer", "jen", "jenny"],
  ["jessica", "jess", "jessie"],
  ["susan", "sue", "suzy"],
  ["margaret", "maggie", "meg", "peggy"],
  ["rebecca", "becky", "becca"],
  ["victoria", "vicky", "tori"],
  ["deborah", "deb", "debbie"],
  ["abigail", "abby"],
  ["isabella", "bella", "izzy"],
  ["madison", "maddie"],
];

const GROUPS = new Map<string, Set<number>>();
NICKNAMES.forEach((g, i) => g.forEach((n) => GROUPS.set(n, (GROUPS.get(n) ?? new Set()).add(i))));

export const cleanName = (s: string | null | undefined) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\- ]/g, "")
    .trim();

/** "Mike" ~ "Michael", "Chris" ~ "Christopher", "Alex" ~ "alex". Not "Mike" ~ "Mia". */
export function firstNamesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanName(a).split(/[\s-]+/)[0] ?? "";
  const y = cleanName(b).split(/[\s-]+/)[0] ?? "";
  if (!x || !y) return false;
  if (x === y) return true;
  const gx = GROUPS.get(x);
  const gy = GROUPS.get(y);
  if (gx && gy && [...gx].some((g) => gy.has(g))) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.startsWith(short);
}

/** Missing on either side is fine; an initial matches; hyphenated names match either half. */
export function lastNamesCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanName(a);
  const y = cleanName(b);
  if (!x || !y) return true;
  if (x === y) return true;
  if (x.length === 1 || y.length === 1) return x[0] === y[0];
  const parts = (s: string) => s.split(/[\s-]+/).filter(Boolean);
  return parts(x).some((p) => parts(y).includes(p));
}

export interface PersonName {
  firstName: string | null | undefined;
  lastName?: string | null | undefined;
}

export function samePerson(a: PersonName, b: PersonName): boolean {
  return firstNamesCompatible(a.firstName, b.firstName) && lastNamesCompatible(a.lastName, b.lastName);
}

export interface MatchCandidate extends PersonName {
  id: string;
  phone: string | null;
  email: string | null;
  createdAt: Date;
}

export type MatchVia = "squire_id" | "email" | "phone" | "contact";

/**
 * Pick the existing client for an incoming identity. Order: email + compatible name, then phone +
 * compatible name. Ties go to an exact first-name match, then a matching last name, then the
 * oldest record. Without a first name, a contact matches only when exactly one client has it.
 */
export function pickMatch(
  input: PersonName & { phone?: string | null; email?: string | null },
  candidates: MatchCandidate[],
): { id: string; via: MatchVia } | null {
  const rank = (list: MatchCandidate[]) =>
    [...list].sort((p, q) => {
      const exact = (c: MatchCandidate) => (cleanName(c.firstName) === cleanName(input.firstName) ? 0 : 1);
      const last = (c: MatchCandidate) => (input.lastName && cleanName(c.lastName) === cleanName(input.lastName) ? 0 : 1);
      return exact(p) - exact(q) || last(p) - last(q) || p.createdAt.getTime() - q.createdAt.getTime();
    })[0];
  const tiers: ["email" | "phone", MatchCandidate[]][] = [
    ["email", input.email ? candidates.filter((c) => c.email === input.email) : []],
    ["phone", input.phone ? candidates.filter((c) => c.phone === input.phone) : []],
  ];
  if (!input.firstName?.trim()) {
    const ids = new Set(tiers.flatMap(([, list]) => list.map((c) => c.id)));
    return ids.size === 1 ? { id: [...ids][0], via: "contact" } : null;
  }
  for (const [via, list] of tiers) {
    const ok = list.filter((c) => samePerson(input, c));
    if (ok.length) return { id: rank(ok).id, via };
  }
  return null;
}
