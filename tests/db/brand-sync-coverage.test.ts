/**
 * Fails when a brand setting or permission isn't registered with the brand change scope: every
 * table and every column of the mixed tables is classified (src/server/brand-sync/coverage.ts),
 * every brand_settings column and brand value has exactly one sync type, nothing outside the scope
 * reads or writes the brand's storage directly or writes what a sync type carries without being
 * listed, every permission of every role reaches the shops a change picks, and every role is a
 * sync item.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let cov: typeof import("@/server/brand-sync/coverage");
let reg: typeof import("@/server/brand-sync/registry");
let settings: typeof import("@/server/brand-sync/settings");
let shopSettings: typeof import("@/server/brand-sync/shop-settings");
let lists: typeof import("@/server/brand-sync/lists");
let orm: typeof import("drizzle-orm");
let pg: typeof import("drizzle-orm/pg-core");
let tables: Map<string, { sql: string; table: unknown }>;

const ROOT = path.resolve(__dirname, "../..");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? walk(f) : /\.(ts|tsx)$/.test(n) ? [f] : [];
  });
}
const SRC = walk(path.join(ROOT, "src")).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));
const inScope = (f: string) => f.startsWith("src/server/brand-sync/") || f.startsWith("src/db/");
const outside = SRC.filter((s) => !inScope(s.file));

beforeAll(async () => {
  m = await loadModules();
  cov = await import("@/server/brand-sync/coverage");
  reg = await import("@/server/brand-sync/registry");
  settings = await import("@/server/brand-sync/settings");
  shopSettings = await import("@/server/brand-sync/shop-settings");
  lists = await import("@/server/brand-sync/lists");
  orm = await import("drizzle-orm");
  pg = await import("drizzle-orm/pg-core");
  tables = new Map();
  for (const [name, t] of Object.entries(m.schema)) if (orm.is(t, pg.PgTable)) tables.set(name, { sql: pg.getTableConfig(t as never).name, table: t });
}, 120_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const sqlNames = () => [...tables.values()].map((t) => t.sql).sort();
const typesOf = (c: import("@/server/brand-sync/coverage").Coverage) => (c.kind === "sync" ? c.types : []);
const adapters = () => Object.values(reg.ADAPTERS);

describe("brand change scope coverage", () => {
  it("classifies every table, and nothing that isn't a table", () => {
    const missing = sqlNames().filter((t) => !(t in cov.TABLES));
    const extra = Object.keys(cov.TABLES).filter((t) => !sqlNames().includes(t));
    expect(missing, "Add these tables to TABLES in src/server/brand-sync/coverage.ts, with the sync type that carries them").toEqual([]);
    expect(extra).toEqual([]);
    for (const [t, c] of Object.entries(cov.TABLES)) {
      if (c.kind === "sync") expect(c.types.length, t).toBeGreaterThan(0);
      else expect(c.why.length, t).toBeGreaterThan(3);
    }
  });

  it("brand lists are exactly the list tables", () => {
    const listTables = lists.LISTS.map((l) => l.table).sort();
    const classified = Object.entries(cov.TABLES)
      .filter(([, c]) => c.kind === "list")
      .map(([t]) => t)
      .sort();
    expect(classified).toEqual(listTables);
  });

  it("classifies every column of the tables that mix settings with other things", () => {
    for (const [sqlName, cols] of Object.entries(cov.COLUMNS)) {
      const t = [...tables.values()].find((x) => x.sql === sqlName);
      expect(t, sqlName).toBeDefined();
      const actual = Object.keys(orm.getTableColumns(t!.table as never)).sort();
      expect(actual.filter((c) => !(c in cols)), `Classify these ${sqlName} columns in COLUMNS`).toEqual([]);
      expect(Object.keys(cols).filter((c) => !actual.includes(c)), `${sqlName} no longer has these columns`).toEqual([]);
      const tableTypes = new Set(typesOf(cov.TABLES[sqlName]));
      for (const [c, x] of Object.entries(cols)) for (const type of typesOf(x)) expect(tableTypes.has(type), `${sqlName}.${c}: add ${type} to the table's types`).toBe(true);
    }
  });

  it("every sync type carries something: a table, a column, a brand_settings column or a brand value", () => {
    const used = new Set<string>([...Object.values(cov.TABLES).flatMap(typesOf), ...Object.values(cov.COLUMNS).flatMap((cols) => Object.values(cols).flatMap(typesOf))]);
    for (const a of adapters()) if (a.columns?.length || a.values?.length || a.valuePrefixes?.length) used.add(a.type);
    expect(Object.keys(reg.ADAPTERS).filter((t) => !used.has(t))).toEqual([]);
  });

  it("every adapter and registered setting says who may change it and where", () => {
    for (const a of adapters()) {
      expect(a.brandPerms.length, a.type).toBeGreaterThan(0);
      expect(a.paths.length, a.type).toBeGreaterThan(0);
    }
    for (const s of settings.SETTINGS) {
      expect(s.perms.length, s.key).toBeGreaterThan(0);
      expect(s.paths.length, s.key).toBeGreaterThan(0);
    }
    for (const s of shopSettings.SHOP_SETTINGS) {
      expect(s.perms.length, s.key).toBeGreaterThan(0);
      expect(s.fields.length, s.key).toBeGreaterThan(0);
      for (const f of s.fields) expect(f.key in s.builtin, `${s.key}.${f.key}`).toBe(true);
    }
    expect(new Set(settings.SETTINGS.map((s) => s.key)).size).toBe(settings.SETTINGS.length);
    expect(new Set(shopSettings.SHOP_SETTINGS.map((s) => s.key)).size).toBe(shopSettings.SHOP_SETTINGS.length);
  });

  it("shops columns marked as a setting or shop setting have a registry entry, and the other way round", () => {
    const shops = cov.COLUMNS.shops;
    const byType = (type: string) =>
      Object.entries(shops)
        .filter(([, c]) => typesOf(c).includes(type as never))
        .map(([k]) => k)
        .sort();
    const shopSettingCols = [...new Set(shopSettings.SHOP_SETTINGS.flatMap((s) => s.columns))].sort();
    expect(byType("shop_setting")).toEqual(shopSettingCols);
    const layered = settings.SETTINGS.flatMap((s) => (s.shopLayer ? [s.shopLayer.column] : [])).sort();
    expect(byType("setting")).toEqual(layered);
  });

  it("every brand_settings column is owned by exactly one sync type", () => {
    const cols = Object.keys(orm.getTableColumns(m.schema.brandSettings)).filter((c) => c !== "id" && c !== "updatedAt");
    const owners = new Map<string, string[]>();
    for (const a of adapters()) for (const c of a.columns ?? []) owners.set(c, [...(owners.get(c) ?? []), a.type]);
    expect(cols.filter((c) => !owners.has(c)), "Register these brand_settings columns in the settings registry (src/server/brand-sync/settings.ts)").toEqual([]);
    expect([...owners].filter(([, o]) => o.length > 1)).toEqual([]);
    expect([...owners.keys()].filter((c) => !cols.includes(c))).toEqual([]);
  });

  it("every brand value key has exactly one owner, and every stored one is owned", async () => {
    const exact = adapters().flatMap((a) => (a.values ?? []).map((v) => [v, a.type] as const));
    const prefixes = adapters().flatMap((a) => (a.valuePrefixes ?? []).map((v) => [v, a.type] as const));
    expect(new Set(exact.map(([v]) => v)).size).toBe(exact.length);
    for (const [p, t] of prefixes) {
      expect(prefixes.filter(([q]) => q !== p && (q.startsWith(p) || p.startsWith(q))), t).toEqual([]);
      expect(exact.filter(([v]) => v.startsWith(p)), t).toEqual([]);
    }
    const ownerOf = (key: string) => [...exact.filter(([v]) => v === key), ...prefixes.filter(([p]) => key.startsWith(p))].map(([, t]) => t);
    const stored = await m.db.db.select({ key: m.schema.brandSyncValues.key }).from(m.schema.brandSyncValues);
    expect(stored.filter((r) => ownerOf(r.key).length !== 1).map((r) => r.key)).toEqual([]);
    for (const f of SRC.filter((s) => s.file.startsWith("src/server/brand-sync/")))
      for (const [, key] of f.text.matchAll(/(?:putBrandValue|brandValue(?:<[^>]*>)?)\(\s*(?:tx,\s*)?"([^"]+)"/g)) expect(ownerOf(key), `${f.file}: "${key}"`).toHaveLength(1);
  });

  it("nothing outside the brand change scope reads or writes the brand's storage directly", () => {
    const ids = /\b(brandSettings|brandSyncValues|shopSyncState|brandSyncChanges|brandSyncBatches|brandSyncControls)\b/;
    const raw = /\b(from|update|into|join)\s+(brand_settings|brand_sync_values|shop_sync_state|brand_sync_changes|brand_sync_batches|brand_sync_controls)\b/i;
    const bad = outside.filter((s) => ids.test(s.text) || raw.test(s.text)).map((s) => s.file);
    expect(bad, "Read brand settings with settingAt/brandColumn (src/server/brand-sync/settings.ts) and change them through the brand change scope").toEqual([]);
  });

  it("brand_settings is written outside the scope only by the listed functions, called only from where it's listed", () => {
    const writers = outside.filter((s) => /\bwriteBrandColumn\(/.test(s.text)).map((s) => s.file);
    expect(writers.filter((f) => !(f in cov.BRAND_WRITERS))).toEqual([]);
    for (const [file, w] of Object.entries(cov.BRAND_WRITERS)) {
      const body = SRC.find((s) => s.file === file)?.text ?? "";
      for (const fn of w.fns) {
        expect(body.includes(`function ${fn}`), `${file} has no ${fn}`).toBe(true);
        const callers = outside.filter((s) => s.file !== file && new RegExp(`\\b${fn}\\b`).test(s.text)).map((s) => s.file);
        expect(callers.filter((c) => !(c in w.callers)), `${fn} is called from outside the brand change scope`).toEqual([]);
      }
    }
  });

  it("every write to a table the scope carries is listed with why it isn't a brand change", () => {
    const carried = new Set(Object.entries(cov.TABLES).flatMap(([t, c]) => (c.kind === "sync" || c.kind === "list" ? [t] : [])));
    const bySql = new Map([...tables].map(([name, t]) => [name, t.sql]));
    const found = new Map<string, Set<string>>();
    for (const s of outside) {
      const hits = [
        ...[...s.text.matchAll(/\.(?:insert|update|delete)\(\s*(\w+)\s*\)/g)].map((x) => bySql.get(x[1])),
        ...[...s.text.matchAll(/\b(?:insert\s+into|update|delete\s+from)\s+([a-z_]+)\b/gi)].map((x) => x[1].toLowerCase()),
      ];
      for (const t of hits) if (t && carried.has(t)) found.set(t, (found.get(t) ?? new Set()).add(s.file));
    }
    const unlisted = [...found].flatMap(([t, files]) => [...files].filter((f) => !cov.WRITERS[t]?.[f]).map((f) => `${t} ← ${f}`));
    expect(unlisted, "Send these through the brand change scope, or list them in WRITERS with why").toEqual([]);
    const stale = Object.entries(cov.WRITERS).flatMap(([t, files]) => Object.keys(files).filter((f) => !found.get(t)?.has(f)).map((f) => `${t} ← ${f}`));
    expect(stale, "These no longer write the table; take them out of WRITERS").toEqual([]);
  });

  it("every permission is part of what a role sends to shops, or brand-only and the brand's at every shop", async () => {
    const { ALL_PERMISSIONS, BRAND_ONLY } = await import("@/domain/permissions");
    const view = reg.ADAPTERS.role.view({ key: null, brandLevel: true, name: "All", description: "", permissions: [...ALL_PERMISSIONS], maxDiscountPct: 10, defaultScope: "all" }) as { permissions: string[] };
    expect(ALL_PERMISSIONS.filter((p) => !BRAND_ONLY.has(p) && !view.permissions.includes(p))).toEqual([]);
  });

  it("every role but the Brand Owner is a role sync item", async () => {
    const { OWNER_ROLE_KEY } = await import("@/domain/permissions");
    const rows = await m.db.db.select({ id: m.schema.roles.id, key: m.schema.roles.key }).from(m.schema.roles);
    const items = new Set((await reg.ADAPTERS.role.items(m.db.db)).map((i) => i.id));
    expect(rows.filter((r) => r.key !== OWNER_ROLE_KEY && !items.has(r.id)).map((r) => r.key)).toEqual([]);
    expect(rows.filter((r) => r.key === OWNER_ROLE_KEY && items.has(r.id))).toEqual([]);
  });

  it("a role change sent to one shop changes every one of its permissions there and none at the other", async () => {
    const { ALL_PERMISSIONS, BRAND_ONLY, effectiveAccess } = await import("@/domain/permissions");
    const { loadStaffAccess } = await import("@/server/auth/access");
    const sync = await import("@/server/brand-sync/engine");
    const { shops, roles, staff } = m.schema;
    const open = await m.db.db.select({ id: shops.id }).from(shops).where(orm.ne(shops.status, "archived")).orderBy(shops.name);
    const [a, b] = [open[0].id, open[1].id];
    const [role] = await m.db.db.insert(roles).values({ name: "Coverage every permission", permissions: [...ALL_PERMISSIONS], maxDiscountPct: 20, defaultScope: "all" }).returning();
    const [person] = await m.db.db
      .insert(staff)
      .values({ staffCode: "COV-ALL", firstName: "Cov", displayLabel: "Cov", publicSlug: "cov-all", roleId: role.id, shopScope: "all" })
      .returning();
    const brandOnly = ALL_PERMISSIONS.filter((p) => BRAND_ONLY.has(p));
    const def = (permissions: string[], maxDiscountPct: number) => ({ key: null, name: role.name, permissions, maxDiscountPct, brandLevel: false });

    const before = (await loadStaffAccess(person.id))!;
    expect([...before.byShop.get(a)!.permissions].sort()).toEqual([...effectiveAccess(def([...ALL_PERMISSIONS], 20)).permissions].sort());

    const r = await sync.commitBrandChange(
      { actor, ctx: null },
      { changes: [{ type: "role", item: role.id, value: { name: role.name, description: "", permissions: brandOnly, maxDiscountPct: 5, defaultScope: "all" } }], scope: "selected", shopIds: [a], overrides: {} },
    );
    expect(r.status).toBe("applied");
    const after = (await loadStaffAccess(person.id))!;
    const atA = [...after.byShop.get(a)!.permissions].sort();
    const atB = [...after.byShop.get(b)!.permissions].sort();
    expect(atA).toEqual([...effectiveAccess(def(brandOnly, 5)).permissions].sort());
    expect(atB).toEqual([...effectiveAccess(def([...ALL_PERMISSIONS], 20)).permissions].sort());
    expect(atB.length).toBeGreaterThan(atA.length);
    expect(after.byShop.get(b)!.maxDiscountPct).toBe(20);

    await m.db.db.delete(staff).where(orm.eq(staff.id, person.id));
  });

  it("a shop setting set once for the brand reaches the shops picked and no others", async () => {
    const sync = await import("@/server/brand-sync/engine");
    const { shops } = m.schema;
    const open = await m.db.db.select({ id: shops.id, n: shops.negativeStock }).from(shops).where(orm.ne(shops.status, "archived")).orderBy(shops.name);
    const [a, b] = [open[0], open[1]];
    await m.db.db.update(shops).set({ negativeStock: "block" }).where(orm.inArray(shops.id, [a.id, b.id]));
    const r = await sync.commitBrandChange({ actor, ctx: null }, { changes: [{ type: "shop_setting", item: "negative_stock", value: { policy: "warn" } }], scope: "selected", shopIds: [a.id], overrides: {} });
    expect(r.status).toBe("applied");
    const now = new Map((await m.db.db.select({ id: shops.id, n: shops.negativeStock }).from(shops).where(orm.inArray(shops.id, [a.id, b.id]))).map((x) => [x.id, x.n]));
    expect(now.get(a.id)).toBe("warn");
    expect(now.get(b.id)).toBe("block");
    await sync.rollbackSync({ actor, ctx: null }, r.batchId);
    expect((await m.db.db.select({ n: shops.negativeStock }).from(shops).where(orm.eq(shops.id, a.id)))[0].n).toBe("block");
  });

  it("a brand interval sent to one shop folds that shop's own interval in, and leaves the other shop's own", async () => {
    const sync = await import("@/server/brand-sync/engine");
    const { brandInterval } = await import("@/server/timing");
    const { shops } = m.schema;
    const open = await m.db.db.select({ id: shops.id }).from(shops).where(orm.ne(shops.status, "archived")).orderBy(shops.name);
    const [a, b] = [open[0].id, open[1].id];
    await m.db.db.update(shops).set({ slotIntervalMinutes: 10 }).where(orm.inArray(shops.id, [a, b]));
    await sync.noteShopEdit("setting", ["slot_interval"], a);
    await sync.noteShopEdit("setting", ["slot_interval"], b);
    const r = await sync.commitBrandChange({ actor, ctx: null }, { changes: [{ type: "setting", item: "slot_interval", value: 20 }], scope: "selected", shopIds: [a], overrides: { [a]: "replace" } });
    expect(r.status).toBe("applied");
    const cols = new Map((await m.db.db.select({ id: shops.id, n: shops.slotIntervalMinutes }).from(shops).where(orm.inArray(shops.id, [a, b]))).map((x) => [x.id, x.n]));
    expect(cols.get(a)).toBeNull();
    expect(await brandInterval(a)).toBe(20);
    expect(cols.get(b)).toBe(10);
    await m.db.db.update(shops).set({ slotIntervalMinutes: null }).where(orm.inArray(shops.id, [a, b]));
  });
});
