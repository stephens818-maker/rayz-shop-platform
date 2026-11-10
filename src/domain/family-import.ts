/**
 * Squire family records in a clients export. Squire has no single family format: some exports name
 * the parent's client ID on each kid's row, some share a family or household ID with a column
 * marking who's the child, and some give the parent's phone. Whatever a file has is turned into
 * parent → child links here; anything it can't say for sure is left for the duplicates page.
 */

export const FAMILY_ALIASES: Record<"parentId" | "parentPhone" | "familyId" | "isChild" | "birthday", string[]> = {
  parentId: ["parent id", "parent client id", "guardian id", "guardian client id", "primary client id", "account holder id", "family head id", "parent customer id"],
  parentPhone: ["parent phone", "guardian phone", "parent phone number", "guardian phone number", "account holder phone"],
  familyId: ["family id", "household id", "family", "household", "family group", "family account id"],
  isChild: ["child", "is child", "kid", "is kid", "minor", "is minor", "dependent", "is dependent", "child account", "relationship", "family role"],
  birthday: ["birthday", "date of birth", "dob", "birth date", "birthdate"],
};

const norm = (h: string) => h.toLowerCase().replace(/[_\s]+/g, " ").trim();

export type FamilyColumns = Partial<Record<keyof typeof FAMILY_ALIASES, string>>;

export function familyColumns(headers: string[]): FamilyColumns {
  const out: FamilyColumns = {};
  for (const [field, aliases] of Object.entries(FAMILY_ALIASES) as [keyof typeof FAMILY_ALIASES, string[]][]) {
    const hit = headers.find((h) => aliases.includes(norm(h)));
    if (hit) out[field] = hit;
  }
  return out;
}

/** A file can say who's whose child at all. */
export const hasFamilyColumns = (c: FamilyColumns) => !!(c.parentId || c.parentPhone || (c.familyId && c.isChild));

/** "Yes", "child", "kid", "dependent", "son"... true; "no", "parent", "guardian", "adult"... false. */
export function parseChild(v: string | undefined): boolean | undefined {
  if (!v?.trim()) return undefined;
  const s = v.trim().toLowerCase();
  if (/^(y|yes|true|1|x|✓|child|kid|minor|dependent|son|daughter)$/.test(s)) return true;
  if (/^(n|no|false|0|parent|guardian|adult|primary|account holder|head|mother|father|mom|dad)$/.test(s)) return false;
  return undefined;
}

export interface FamilyRow {
  /** 1-based CSV line, for messages. */
  line: number;
  squireId: string | null;
  name: string;
  parentId?: string | null;
  parentPhone?: string | null;
  familyId?: string | null;
  isChild?: boolean;
}

export type ParentRef = { squireId: string } | { phone: string };

export interface FamilyLink {
  line: number;
  childSquireId: string;
  parent: ParentRef;
}

export interface FamilyPlan {
  links: FamilyLink[];
  problems: { line: number; message: string }[];
}

/** Parent → child links a file states, and the rows it names a family for but can't place. */
export function planFamilies(rows: FamilyRow[]): FamilyPlan {
  const plan: FamilyPlan = { links: [], problems: [] };
  const linked = new Set<string>();
  const link = (line: number, child: string, parent: ParentRef) => {
    if ("squireId" in parent && parent.squireId === child) return;
    if (linked.has(child)) return;
    linked.add(child);
    plan.links.push({ line, childSquireId: child, parent });
  };
  for (const r of rows) {
    if (!r.squireId) continue;
    if (r.parentId?.trim() && r.isChild !== false) link(r.line, r.squireId, { squireId: r.parentId.trim() });
    else if (r.parentPhone?.trim() && r.isChild !== false) link(r.line, r.squireId, { phone: r.parentPhone.trim() });
  }
  const groups = new Map<string, FamilyRow[]>();
  for (const r of rows) {
    const f = r.familyId?.trim();
    if (f && r.squireId) groups.set(f, [...(groups.get(f) ?? []), r]);
  }
  for (const [, members] of groups) {
    const kids = members.filter((m) => m.isChild === true && !linked.has(m.squireId!));
    if (!kids.length) continue;
    const adults = members.filter((m) => m.isChild === false);
    // The first adult listed holds the account; other adults in the family keep their own.
    const head = adults[0] ?? null;
    if (!head) {
      for (const k of kids) plan.problems.push({ line: k.line, message: `${k.name}: no parent in their family in this file. Put them on the parent's account from the duplicates page or their profile.` });
      continue;
    }
    for (const k of kids) link(k.line, k.squireId!, { squireId: head.squireId! });
  }
  return plan;
}
