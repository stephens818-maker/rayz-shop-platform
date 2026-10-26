import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { checkoutPromptRules, clientFieldRules, clientFields, roles } from "@/db/schema";
import { Native, onOff } from "@/domain/brand-sync";
import { PROMPT_KINDS, type PromptKind, type PromptRule } from "@/domain/checkout-prompts";
import {
  type FieldKey,
  RULE_VALUE_LABEL,
  SETTING_LABEL,
  type Setting,
  defaultEntry,
  defaultLevel,
  fieldLabel,
  fieldRuleChangeDenied,
  isBuiltinField,
  isEntry,
  isEntryField,
  isLevel,
  isSetting,
} from "@/domain/client-privacy";
import { OWNER_ROLE_KEY, isBrandLevelRole } from "@/domain/permissions";
import { audit } from "../../audit";
import { callerRights } from "../../client-privacy";
import { AppError, forbidden, notFound } from "../../errors";
import { localValues } from "../store";
import type { SyncAdapter } from "../types";

// ───────────────────────────── Client data access per role ─────────────────────────────

/**
 * What a role sees of each client field and may add or edit: the role's brand-wide rules, one item
 * per role. A shop's own version is the role's rules at that shop (client_field_rules with its
 * shop_id), which resolveLevel already puts ahead of the brand's. Rules for one person stay with
 * that person.
 *
 * A value is "<setting>:<field>" to a level, leaving out what equals the role's built-in default,
 * so a shop that sets a field back to the default matches a brand with no rule for it.
 */
type Rules = Record<string, string>;
type FieldRuleBrand = { roleKey: string | null; fullContact: boolean; rules: Rules };

const ruleKey = (setting: Setting, field: string) => `${setting}:${field}`;
const splitKey = (k: string) => {
  const i = k.indexOf(":");
  return { setting: k.slice(0, i) as Setting, field: k.slice(i + 1) as FieldKey };
};
const defaultOf = (roleKey: string | null, k: string) => {
  const { setting, field } = splitKey(k);
  return setting === "view" ? defaultLevel(roleKey, field) : defaultEntry(roleKey, field, setting) ? "allow" : "deny";
};
const normalize = (roleKey: string | null, rules: Rules): Rules =>
  Object.fromEntries(
    Object.entries(rules)
      .filter(([k, l]) => l !== defaultOf(roleKey, k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );

async function roleRows(tx: DBorTx, ids?: readonly string[]) {
  return tx
    .select({ id: roles.id, key: roles.key, name: roles.name, brandLevel: roles.brandLevel, sortOrder: roles.sortOrder })
    .from(roles)
    .where(and(ids ? inArray(roles.id, ids.length ? [...ids] : [crypto.randomUUID()]) : undefined))
    .orderBy(asc(roles.sortOrder), asc(roles.name));
}

async function fieldNames(tx: DBorTx) {
  return tx.select({ id: clientFields.id, label: clientFields.label }).from(clientFields);
}

export const fieldRuleAdapter: SyncAdapter<FieldRuleBrand, Rules> = {
  type: "field_rule",
  noun: "Client data access",
  area: "clients",
  store: "native",
  live: true,
  brandPerms: ["clients.privacy"],
  lockable: false,
  note: "Rules for one person stay that person's. The Brand Owner and Brand Admins always see everything.",
  paths: ["/admin/client-data", "/admin/customers"],
  async items(tx) {
    return (await roleRows(tx)).filter((r) => r.key !== OWNER_ROLE_KEY).map((r) => ({ id: r.id, label: r.name, hint: "Client data access" }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rs = (await roleRows(tx, ids)).filter((r) => r.key !== OWNER_ROLE_KEY);
    const rows = await tx
      .select()
      .from(clientFieldRules)
      .where(and(inArray(clientFieldRules.roleId, rs.length ? rs.map((r) => r.id) : [crypto.randomUUID()]), isNull(clientFieldRules.staffId), isNull(clientFieldRules.shopId)));
    return new Map(rs.map((r) => [r.id, { roleKey: r.key, fullContact: isBrandLevelRole(r), rules: Object.fromEntries(rows.filter((x) => x.roleId === r.id).map((x) => [ruleKey(x.setting, x.field), x.level])) }]));
  },
  view: (b) => normalize(b.roleKey, b.rules),
  async parse(who, raw, item, before, tx) {
    if (!before) throw notFound("Role");
    const changes = z.record(z.string(), z.string().nullable()).parse(raw);
    const custom = await fieldNames(tx);
    const next: Rules = { ...before.rules };
    const rights = who.ctx ? await callerRights(who.ctx) : null;
    for (const [k, level] of Object.entries(changes)) {
      const { setting, field } = splitKey(k);
      if (!isSetting(setting) || !(isBuiltinField(field) || custom.some((c) => `custom:${c.id}` === field))) throw new AppError("bad_request", "Unknown field");
      if (setting !== "view" && !isEntryField(field)) throw new AppError("bad_request", "That field can't be entered");
      if (level !== null && !(setting === "view" ? isLevel(level) : isEntry(level))) throw new AppError("bad_request", "Pick a level");
      if (who.ctx && rights && (before.rules[k] ?? null) !== level) {
        const denied = fieldRuleChangeDenied(
          { staffId: who.ctx.staff.id, roleId: who.ctx.access.role.id, isOwner: who.ctx.isOwner, ...rights },
          { field, setting, roleId: item, roleKey: before.roleKey, staffId: null, shopId: null, level, fullContact: before.fullContact },
        );
        if (denied) throw forbidden(denied);
      }
      if (level === null) delete next[k];
      else next[k] = level;
    }
    return { ...before, rules: next };
  },
  async shops(tx, ids, shopIds, brand) {
    if (!ids.length || !shopIds.length) return new Map();
    const rows = await tx
      .select()
      .from(clientFieldRules)
      .where(and(inArray(clientFieldRules.roleId, [...ids]), isNull(clientFieldRules.staffId), inArray(clientFieldRules.shopId, [...shopIds])));
    const out = new Map<string, Native<Rules>>();
    for (const id of ids) {
      const b = brand.get(id);
      if (!b) continue;
      for (const shopId of shopIds) {
        const own = rows.filter((r) => r.roleId === id && r.shopId === shopId);
        // Fields the shop has no rule for read the brand's.
        out.set(`${shopId}|${id}`, { value: normalize(b.roleKey, { ...b.rules, ...Object.fromEntries(own.map((r) => [ruleKey(r.setting, r.field), r.level])) }), follows: !own.length, ...(own.length ? { partial: true } : {}) });
      }
    }
    return out;
  },
  async write(tx, who, item, brand, writes) {
    const [role] = await roleRows(tx, [item]);
    if (!role) return;
    if (brand?.to) {
      await tx.delete(clientFieldRules).where(and(eq(clientFieldRules.roleId, item), isNull(clientFieldRules.staffId), isNull(clientFieldRules.shopId)));
      const rows = Object.entries(brand.to.rules).map(([k, level]) => ({ ...splitKey(k), level, roleId: item, staffId: null, shopId: null, updatedBy: who.actor.staffId ?? null }));
      if (rows.length) await tx.insert(clientFieldRules).values(rows as (typeof clientFieldRules.$inferInsert)[]);
      await audit(who.actor, "client_data.role_rules", "role", item, { role: role.name, before: brand.from?.rules ?? null, after: brand.to.rules, via: "brand_sync" }, null, tx);
    }
    const brandRules = brand?.to?.rules ?? (await fieldRuleAdapter.brand(tx, [item])).get(item)?.rules ?? {};
    for (const [shopId, w] of writes) {
      await tx.delete(clientFieldRules).where(and(eq(clientFieldRules.roleId, item), isNull(clientFieldRules.staffId), eq(clientFieldRules.shopId, shopId)));
      if (!w.follow) {
        // Every key the brand or the shop sets is written at the shop, so a later brand change doesn't reach it.
        const keys = [...new Set([...Object.keys(brandRules), ...Object.keys(w.value)])];
        const rows = keys.map((k) => ({ ...splitKey(k), level: w.value[k] ?? defaultOf(role.key, k), roleId: item, staffId: null, shopId, updatedBy: who.actor.staffId ?? null }));
        if (rows.length) await tx.insert(clientFieldRules).values(rows as (typeof clientFieldRules.$inferInsert)[]);
      }
      await audit(who.actor, "client_data.role_rules", "role", item, { role: role.name, rules: w.follow ? "brand" : w.value, via: "brand_sync" }, shopId, tx);
    }
  },
  describe(v) {
    const out: Record<string, string> = {};
    for (const [k, l] of Object.entries(v)) {
      const { setting, field } = splitKey(k);
      out[`${fieldLabel(field)} · ${SETTING_LABEL[setting] ?? setting}`] = RULE_VALUE_LABEL[l as keyof typeof RULE_VALUE_LABEL] ?? l;
    }
    return Object.keys(out).length ? out : { Rules: "Built-in defaults" };
  },
  short: (v) => {
    const n = Object.keys(v).length;
    return n ? `${n} rule${n === 1 ? "" : "s"}` : "Defaults";
  },
};

// ───────────────────────────── Checkout prompts per role ─────────────────────────────

/**
 * A checkout prompt switched on or off for whoever has a role at checkout: one item per role. A shop
 * can have its own (kept in shop_sync_state), which its tickets use instead of the brand's rule.
 * Rules for one location are that location's; rules for one barber are that barber's.
 */
export type PromptRuleValue = Record<PromptKind, boolean | null>;
const NONE: PromptRuleValue = { rebook: null, product: null };
const PromptRuleInput = z.object({ rebook: z.boolean().nullable(), product: z.boolean().nullable() }).partial();

export const promptRuleAdapter: SyncAdapter<PromptRuleValue, PromptRuleValue> = {
  type: "prompt_rule",
  noun: "Checkout prompts for a role",
  area: "checkout_prompts",
  store: "local",
  live: true,
  brandPerms: ["checkout_prompts.manage"],
  lockable: false,
  note: "A barber's own rule still comes first. Off means the role never sees the prompt; no rule follows the location.",
  paths: ["/admin/checkout-prompts"],
  async items(tx) {
    return (await roleRows(tx)).map((r) => ({ id: r.id, label: r.name, hint: "Checkout prompts" }));
  },
  async brand(tx, ids) {
    if (!ids.length) return new Map();
    const rs = await roleRows(tx, ids);
    const rows = await tx.select().from(checkoutPromptRules).where(inArray(checkoutPromptRules.roleId, rs.length ? rs.map((r) => r.id) : [crypto.randomUUID()]));
    return new Map(rs.map((r) => [r.id, Object.fromEntries(PROMPT_KINDS.map((k) => [k, rows.find((x) => x.roleId === r.id && x.prompt === k)?.enabled ?? null])) as PromptRuleValue]));
  },
  view: (b) => ({ ...NONE, ...b }),
  async parse(_who, raw, _item, before) {
    if (!before) throw notFound("Role");
    const r = PromptRuleInput.safeParse(raw);
    if (!r.success) throw new AppError("bad_request", "Pick on, off or no rule");
    return { ...before, ...r.data };
  },
  async write(tx, who, item, brand) {
    if (!brand?.to) return;
    for (const k of PROMPT_KINDS) {
      const where = and(eq(checkoutPromptRules.prompt, k), eq(checkoutPromptRules.roleId, item), isNull(checkoutPromptRules.shopId), isNull(checkoutPromptRules.staffId));
      await tx.delete(checkoutPromptRules).where(where);
      const enabled = brand.to[k];
      if (enabled !== null) await tx.insert(checkoutPromptRules).values({ prompt: k, roleId: item, enabled, updatedBy: who.actor.staffId ?? null });
    }
    await audit(who.actor, "checkout_prompts.rule", "checkout_prompt_rule", null, { target: "role", targetId: item, before: brand.from, after: brand.to, via: "brand_sync" }, null, tx);
  },
  describe: (v) => Object.fromEntries(PROMPT_KINDS.map((k) => [k === "rebook" ? "Rebook prompt" : "Product suggestions", v[k] === null ? "No rule" : onOff(v[k]!)])),
  short: (v) => PROMPT_KINDS.map((k) => `${k === "rebook" ? "Rebook" : "Products"} ${v[k] === null ? "—" : v[k] ? "on" : "off"}`).join(" · "),
};

/** The prompt rules a ticket at a shop goes by: role rules as that shop has them. */
export async function promptRulesAt(rules: readonly PromptRule[], shopId: string, tx: DBorTx = db): Promise<PromptRule[]> {
  const own = await localValues<PromptRuleValue>("prompt_rule", [shopId], tx);
  if (!own.size) return [...rules];
  const ownRoles = new Map([...own].map(([k, v]) => [k.slice(shopId.length + 1), v]));
  const kept = rules.filter((r) => !(r.roleId && ownRoles.has(r.roleId)));
  const local: PromptRule[] = [...ownRoles].flatMap(([roleId, v]) => PROMPT_KINDS.filter((k) => v[k] !== null && v[k] !== undefined).map((k) => ({ prompt: k, shopId: null, roleId, staffId: null, enabled: v[k]! })));
  return [...kept, ...local];
}
