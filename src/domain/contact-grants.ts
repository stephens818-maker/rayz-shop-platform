/**
 * Contact access grants: the brand's explicit exceptions to "shop logins and staff never see a
 * client's full phone, email or address and never export client lists". Pure: what a grant gives,
 * whether it's in force, and who may give or take one away.
 *
 * A grant is to one person (wherever they work) or to one location (everyone working there,
 * including its shop login). Viewing and exporting are separate grants. Brand-level people don't
 * need them: they see contact details as Client data sets them, and export with the permission.
 */
import { Access, CLIENT_LIST_REPORTS, Permission, reportExport, reportView } from "./permissions";

export const CONTACT_GRANT_KINDS = ["full_contact", "export"] as const;
export type ContactGrantKind = (typeof CONTACT_GRANT_KINDS)[number];
export const isContactGrantKind = (v: unknown): v is ContactGrantKind => typeof v === "string" && (CONTACT_GRANT_KINDS as readonly string[]).includes(v);

export const CONTACT_GRANT_LABEL: Record<ContactGrantKind, string> = {
  full_contact: "See phone, email and address in full",
  export: "Export and download client lists",
};

export const CONTACT_GRANT_HINT: Record<ContactGrantKind, string> = {
  full_contact: "Client phone numbers, emails and addresses show in full on profiles, lists, search and receipts, instead of masked.",
  export:
    "The client list CSV and customer custom reports, plus the Campaign Center contacts and the client ratings CSV for people who can open those. Only their own locations' clients, with details as they see them. Every download is logged.",
};

export interface ContactGrant {
  id: string;
  kind: ContactGrantKind;
  staffId: string | null;
  shopId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export const grantInForce = (g: Pick<ContactGrant, "expiresAt" | "revokedAt">, now: Date = new Date()) => !g.revokedAt && (!g.expiresAt || g.expiresAt > now);

export type GrantStatus = "active" | "expired" | "revoked";
export const grantStatus = (g: Pick<ContactGrant, "expiresAt" | "revokedAt">, now: Date = new Date()): GrantStatus =>
  g.revokedAt ? "revoked" : g.expiresAt && g.expiresAt <= now ? "expired" : "active";

/** What one person holds: grants to them everywhere, and grants to each location. */
export interface HeldGrants {
  everywhere: Set<ContactGrantKind>;
  byShop: Map<string, Set<ContactGrantKind>>;
}

export function heldGrants(grants: readonly ContactGrant[], staffId: string, now: Date = new Date()): HeldGrants {
  const held: HeldGrants = { everywhere: new Set(), byShop: new Map() };
  for (const g of grants) {
    if (!grantInForce(g, now)) continue;
    if (g.staffId === staffId) held.everywhere.add(g.kind);
    else if (!g.staffId && g.shopId) held.byShop.set(g.shopId, new Set([...(held.byShop.get(g.shopId) ?? []), g.kind]));
  }
  return held;
}

export const kindsAt = (held: HeldGrants, shopId: string): Set<ContactGrantKind> => new Set([...held.everywhere, ...(held.byShop.get(shopId) ?? [])]);

/**
 * The permissions a grant adds. Exporting adds each client-list download the person can otherwise
 * open: the client list always, the Campaign Center contacts with its view, and each client-list
 * report's CSV with that report.
 */
export function grantPermissions(kinds: ReadonlySet<ContactGrantKind>, has: ReadonlySet<Permission>): Permission[] {
  const out: Permission[] = [];
  if (kinds.has("full_contact")) out.push("clients.contact_full");
  if (kinds.has("export")) {
    out.push("clients.export");
    if (has.has("campaign_center.view")) out.push("campaign_center.export");
    for (const r of CLIENT_LIST_REPORTS) if (has.has(reportView(r))) out.push(reportExport(r));
  }
  return out;
}

export function withGrantKinds<A extends Access>(a: A, kinds: ReadonlySet<ContactGrantKind>): A {
  if (!kinds.size) return a;
  return { ...a, permissions: new Set([...a.permissions, ...grantPermissions(kinds, a.permissions)]) };
}

export interface GrantCaller {
  /** A brand-level person with "Set which client details each role and person sees". */
  managesPrivacy: boolean;
  /** Whether they see contact details in full and may export client lists themselves. */
  seesFullContact: boolean;
  mayExport: boolean;
}

/** Giving or revoking a grant: only brand-level people who manage client data, and only what they hold themselves. */
export function grantChangeDenied(caller: GrantCaller, g: { kind: ContactGrantKind; staffId: string | null; shopId: string | null; expiresAt?: Date | null }, now: Date = new Date()): string | null {
  if (!caller.managesPrivacy) return "Only brand-level people who manage client data protection can give or revoke contact access";
  if (!isContactGrantKind(g.kind)) return "Pick what to give";
  if (!!g.staffId === !!g.shopId) return "Pick a location or a person";
  if (g.kind === "full_contact" && !caller.seesFullContact) return "You can't give full contact details because you don't see them yourself";
  if (g.kind === "export" && !caller.mayExport) return "You can't give exporting because you can't export the client list yourself";
  if (g.expiresAt && g.expiresAt <= now) return "Pick an end date in the future, or none";
  return null;
}
