import "server-only";
import { createHash } from "node:crypto";
import { and, eq, inArray, or, sql, type Column, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { appointments, couponCodes, couponRedemptions, customerSquireIds, customerTags, customers, giftCards, sales } from "@/db/schema";
import { maskPhone } from "@/domain/client-privacy";
import { ageOn } from "@/domain/family";
import { PROBE_RULES, Probe, ProbeKind, allowedProbes, matchLabel, parseSearch, shortName, type ClientHit } from "@/domain/client-search";
import { todayLocal } from "@/lib/time";
import { can, type StaffContext } from "./auth/staff";
import { shownBadges } from "./badges";
import { ClientPolicy, clientPolicy, recordClientAccess } from "./client-privacy";
import { shopClientsScope, visitedScope } from "./customers";
import { DEMO_CLIENT_SOURCE } from "./demo-shop";
import { loyaltyCardValid } from "./loyalty-card";
import { ratingSummaries } from "./ratings";

export type { ClientHit };

export interface SearchOptions {
  /** Where the search came from, for the data-access report: "clients", "booking", "pos", "walk_in", "header", "merge". */
  via: string;
  limit?: number;
  /** Only clients this barber has served: the client list for people without "every client". */
  ownClientsOf?: string;
  /** Ticket and appointment numbers from every shop too, whatever the searcher's shops (the merge tool, which needs access to all shops). */
  brandWide?: boolean;
  /** Skip logging when the caller logs the look itself (the client list logs its page view). */
  record?: boolean;
}

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const esc = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const sn = customers.searchName;
const fullName = sql`lower(${customers.firstName} || ' ' || coalesce(${customers.lastName}, ''))`;
const lastFirst = sql`lower(coalesce(${customers.lastName}, '') || ' ' || ${customers.firstName})`;
/** Typo tolerance: how alike a typed word and a word of the name must be (pg_trgm word similarity). */
const FUZZY = "0.45";

type Found = { id: string; score: number };

interface Scope {
  /** Which clients a partial term may reach. Undefined: every client. */
  clients?: SQL;
  /** Which shops' tickets and appointments. Undefined: every shop. */
  shops?: readonly string[];
}

/**
 * Clients are the brand's, not a shop's: staff at any shop look up and book any client by any part
 * of their name or details (what they then see is the client policy's call). Only a barber's own
 * client list is limited to the people they've cut, and ticket and appointment numbers still find
 * only the searcher's shops' tickets.
 */
function scopeFor(ctx: StaffContext, o: SearchOptions): Scope {
  const shops = o.brandWide || ctx.brandWide ? undefined : ctx.shopIds;
  return o.ownClientsOf ? { clients: visitedScope({ staffId: o.ownClientsOf }), shops } : { shops };
}

async function ids(q: Promise<{ id: string | null; score?: number }[]>, base: number): Promise<Found[]> {
  return (await q).flatMap((r) => (r.id ? [{ id: r.id, score: base + (r.score ?? 0) }] : []));
}

function nameQuery(p: Extract<Probe, { kind: "name" }>, scope: Scope, cap: number, base: number): Promise<Found[]> {
  const words = p.tokens.map((t) => (t.length <= 2 ? sql`(' ' || ${sn}) like ${`% ${esc(t)}%`}` : sql`(${sn} like ${`%${esc(t)}%`} or ${t} <% ${sn})`));
  const match = and(...words, p.last4 ? sql`right(${customers.phone}, 4) = ${p.last4}` : undefined)!;
  const exact = or(sql`${fullName} = ${p.text}`, sql`${lastFirst} = ${p.text}`)!;
  const where = scope.clients ? or(and(match, scope.clients), and(exact, p.last4 ? sql`right(${customers.phone}, 4) = ${p.last4}` : undefined)) : match;
  const score = sql<number>`(word_similarity(${p.text}, ${sn}) + similarity(${p.text}, ${sn})
    + case when ${fullName} = ${p.text} or ${lastFirst} = ${p.text} then 2 when ${sn} like ${`${esc(p.text)}%`} then 1 else 0 end)::float8`;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('pg_trgm.word_similarity_threshold', ${FUZZY}, true)`);
    return ids(tx.select({ id: customers.id, score }).from(customers).where(where).orderBy(sql`${score} desc`).limit(cap), base);
  });
}

function probeQuery(p: Probe, scope: Scope, cap: number): Promise<Found[]> {
  const base = PROBE_RULES[p.kind].rank;
  const reach = PROBE_RULES[p.kind].reach;
  const c = (cond: SQL) => ids(db.select({ id: customers.id }).from(customers).where(reach === "scoped" ? and(cond, scope.clients) : cond).limit(cap), base);
  const atShops = (col: Column) => (scope.shops ? (scope.shops.length ? inArray(col, [...scope.shops]) : sql`false`) : undefined);
  switch (p.kind) {
    case "name":
      return nameQuery(p, scope, cap, base);
    case "phone":
      return c(eq(customers.phoneHash, sha(p.e164)));
    case "email":
      return c(eq(customers.emailHash, sha(p.email)));
    case "birthday":
      return c(eq(customers.birthdayHash, sha(p.iso)));
    case "address":
      return c(eq(customers.addressHash, sha(p.key)));
    case "phone_last4":
      return c(sql`${customers.phone} like ${`%${p.digits}`}`);
    case "phone_part":
      return c(sql`${customers.phone} like ${`%${p.digits}%`}`);
    case "email_part":
      return c(sql`lower(${customers.email}) like ${`%${esc(p.text)}%`}`);
    case "client_id":
      return c(eq(customers.id, p.id));
    case "client_number":
      return c(eq(customers.number, p.n));
    case "birthday_md":
      return c(sql`extract(month from ${customers.birthday}) = ${p.month} and extract(day from ${customers.birthday}) = ${p.day}`);
    case "zip":
      return c(eq(customers.addressZip, p.zip));
    case "city":
      return c(eq(customers.addressCity, p.city));
    case "address_part":
      return c(sql`lower(${customers.address}) like ${`%${esc(p.text)}%`}`);
    case "notes":
      return c(sql`lower(${customers.notes}) like ${`%${esc(p.text)}%`}`);
    case "tag":
      return c(sql`exists (select 1 from ${customerTags} t where t.customer_id = ${customers.id} and lower(t.tag) like ${`${esc(p.text)}%`})`);
    case "loyalty_card":
      return db
        .select({ id: customers.id, number: customers.number })
        .from(customers)
        .where(eq(customers.number, p.n))
        .then((rows) => rows.filter((r) => loyaltyCardValid(r, p.sig)).map((r) => ({ id: r.id, score: base })));
    case "ticket":
      return ids(db.select({ id: sales.customerId }).from(sales).where(and(eq(sales.number, p.n), atShops(sales.shopId))).limit(1), base);
    case "appointment":
      return ids(db.select({ id: appointments.customerId }).from(appointments).where(and(eq(appointments.code, p.code), atShops(appointments.shopId))).limit(1), base);
    case "gift_card":
      return ids(db.select({ id: giftCards.customerId }).from(giftCards).where(inArray(giftCards.code, p.codes)).limit(5), base);
    case "coupon":
      return ids(
        db
          .select({ id: sql<string | null>`coalesce(${couponCodes.customerId}, ${couponRedemptions.customerId})` })
          .from(couponCodes)
          .leftJoin(couponRedemptions, eq(couponRedemptions.couponCodeId, couponCodes.id))
          .where(eq(couponCodes.code, p.code))
          .limit(5),
        base,
      );
    case "squire_id":
      return ids(db.select({ id: customerSquireIds.customerId }).from(customerSquireIds).where(eq(customerSquireIds.squireId, p.id)).limit(1), base);
  }
}

/**
 * A search that finds a child finds their parent too, right after them: the desk looks a family up
 * by the child's name. A child in the searcher's reach brings their parent with them: one family.
 */
async function withGuardians(ranked: { id: string; matched: Set<string> }[]) {
  if (!ranked.length) return ranked;
  const kids = await db
    .select({ id: customers.id, g: customers.guardianId })
    .from(customers)
    .where(and(inArray(customers.id, ranked.map((r) => r.id)), sql`${customers.guardianId} is not null`));
  if (!kids.length) return ranked;
  const guardianOf = new Map(kids.map((k) => [k.id, k.g!]));
  const out: { id: string; matched: Set<string> }[] = [];
  const seen = new Set<string>();
  for (const r of ranked) {
    if (seen.has(r.id)) continue;
    out.push(r);
    seen.add(r.id);
    const g = guardianOf.get(r.id);
    if (g && !seen.has(g)) {
      const had = ranked.find((x) => x.id === g);
      out.push({ id: g, matched: new Set([...(had?.matched ?? []), "Child's name"]) });
      seen.add(g);
    }
  }
  return out;
}

/** Matching client ids, best first, with how each matched. Logs nothing: see searchClients. */
export async function findClients(ctx: StaffContext, policy: ClientPolicy, term: string, o: SearchOptions): Promise<{ ranked: { id: string; matched: Set<string> }[]; kinds: ProbeKind[] }> {
  const probes = allowedProbes(parseSearch(term), (f) => policy.level(f));
  if (!probes.length) return { ranked: [], kinds: [] };
  const scope = scopeFor(ctx, o);
  const limit = o.limit ?? 8;
  const cap = Math.min(500, Math.max(limit * 5, 40));
  const found = await Promise.all(probes.map((p) => probeQuery(p, scope, cap).then((rows) => ({ p, rows }))));
  const best = new Map<string, { score: number; matched: Set<string> }>();
  for (const { p, rows } of found)
    for (const r of rows) {
      const cur = best.get(r.id) ?? { score: 0, matched: new Set<string>() };
      cur.score = Math.max(cur.score, r.score);
      cur.matched.add(matchLabel(p));
      best.set(r.id, cur);
    }
  let ranked = [...best.entries()].sort((a, b) => b[1].score - a[1].score).map(([id, v]) => ({ id, matched: v.matched }));
  // Ticket and appointment matches came from the ticket; the client must still be in reach.
  if (o.ownClientsOf && ranked.length) {
    const ok = new Set((await db.select({ id: customers.id }).from(customers).where(and(inArray(customers.id, ranked.map((r) => r.id)), visitedScope({ staffId: o.ownClientsOf })))).map((r) => r.id));
    ranked = ranked.filter((r) => ok.has(r.id));
  }
  // ST-I19: the Demo Shop's reviewer finds only demo clients, and nobody else ever finds them.
  if (ranked.length) {
    const demo = new Set((await db.select({ id: customers.id }).from(customers).where(and(inArray(customers.id, ranked.map((r) => r.id)), eq(customers.source, DEMO_CLIENT_SOURCE)))).map((r) => r.id));
    ranked = ranked.filter((r) => demo.has(r.id) === !!ctx.staff.demo);
  }
  // A matched child's parent comes along even past the limit: the pickers list the family under them.
  ranked = o.ownClientsOf ? ranked.slice(0, limit) : await withGuardians(ranked.slice(0, limit));
  return { ranked, kinds: [...new Set(found.filter((f) => f.rows.length).map((f) => f.p.kind))] };
}

/**
 * Whose photos someone may load: anyone's with "every client", otherwise their shops' clients and
 * clients they've served.
 */
export const photoReach = (ctx: StaffContext): SQL | undefined =>
  can(ctx, "clients.view_all") ? undefined : or(shopClientsScope(ctx.shopIds), visitedScope({ staffId: ctx.staff.id }));

/** The disambiguators for these clients, as the searcher may see them. */
export async function clientHits(ctx: StaffContext, policy: ClientPolicy, ranked: { id: string; matched: Set<string> }[]): Promise<ClientHit[]> {
  if (!ranked.length) return [];
  const reach = photoReach(ctx);
  const list = sql.join(
    ranked.map((r) => sql`${r.id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    select c.id, c.number, c.first_name, c.last_name, c.nickname, c.phone, c.email, c.notes, c.guardian_id, g.first_name g_first, g.last_name g_last,
      (select json_agg(json_build_object('id', k.id, 'firstName', k.first_name, 'birthday', k.birthday, 'birthYear', k.birth_year) order by k.created_at, k.id)
        from customers k where k.guardian_id = c.id) kids,
      lv.starts_at last_at, ls.name last_shop, coalesce(ps.display_label, ub.display_label) barber,
      exists (select 1 from client_photos p where p.customer_id = c.id) and ${reach ? sql`c.id in (select ${customers.id} from ${customers} where ${reach})` : sql`true`} has_photo
    from customers c
    left join customers g on g.id = c.guardian_id
    left join lateral (select a.starts_at, a.shop_id from appointments a where a.customer_id = c.id and a.status = 'completed' order by a.starts_at desc limit 1) lv on true
    left join shops ls on ls.id = lv.shop_id
    left join staff ps on ps.id = c.preferred_staff_id
    left join lateral (
      select s.display_label from appointments a join staff s on s.id = a.staff_id
      where a.customer_id = c.id and a.status = 'completed' group by s.id, s.display_label order by count(*) desc, max(a.starts_at) desc limit 1
    ) ub on true
    where c.id in (${list})`)) as unknown as {
    id: string;
    number: number;
    first_name: string;
    last_name: string | null;
    nickname: string | null;
    phone: string | null;
    email: string | null;
    notes: string | null;
    guardian_id: string | null;
    g_first: string | null;
    g_last: string | null;
    kids: { id: string; firstName: string; birthday: string | null; birthYear: number | null }[] | null;
    last_at: string | Date | null;
    last_shop: string | null;
    barber: string | null;
    has_photo: boolean;
  }[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const today = todayLocal();
  const [ratings, badges] = await Promise.all([ratingSummaries(rows.map((r) => r.id)), shownBadges(policy, rows.map((r) => r.id))]);
  return ranked.flatMap(({ id, matched }) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id,
        number: r.number,
        firstName: r.first_name,
        lastName: policy.show("last_name", r.last_name),
        short: shortName(r.first_name, policy.level("last_name") === "hidden" ? null : r.last_name),
        nickname: r.nickname,
        phone: policy.level("phone") === "hidden" ? null : maskPhone(r.phone),
        email: policy.show("email", r.email),
        notes: policy.show("notes", r.notes),
        lastVisit: r.last_at ? { at: new Date(r.last_at).toISOString(), shop: r.last_shop } : null,
        barber: policy.show("preferred_barber", r.barber),
        photo: r.has_photo && policy.level("photo") === "full",
        rating: policy.stars(ratings.get(id)),
        badges: badges.get(id) ?? [],
        matched: [...matched],
        ...(r.guardian_id || r.kids?.length
          ? {
              family: {
                guardian: r.guardian_id ? { id: r.guardian_id, short: shortName(r.g_first ?? "", r.g_last) } : null,
                kids: (r.kids ?? []).map((k) => ({ id: k.id, firstName: k.firstName, age: policy.level("birthday") === "hidden" ? null : ageOn(k, today) })),
              },
            }
          : {}),
      },
    ];
  });
}

/**
 * The one client search: the brand portal's client list and header, booking, the POS, walk-ins and
 * the merge tool. Every search is logged for the data-access report (never the term itself, only
 * which kinds of value matched) and counts toward the lookup limits.
 */
export async function searchClients(ctx: StaffContext, term: string, o: SearchOptions): Promise<ClientHit[]> {
  if (term.trim().length < 2) return [];
  const policy = await clientPolicy(ctx);
  const { ranked, kinds } = await findClients(ctx, policy, term, o);
  if (o.record !== false) await recordClientAccess(ctx, { kind: "search", detail: { via: o.via, results: ranked.length, by: kinds } });
  return clientHits(ctx, policy, ranked);
}
