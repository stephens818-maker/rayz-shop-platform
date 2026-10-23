import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, ne } from "drizzle-orm";
import { db } from "@/db";
import { clientFieldRules, clientFields, roles, shops, staff, staffAccessShops } from "@/db/schema";
import { Badge, Card, CardHeader, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import {
  BUILTIN_FIELDS,
  Entry,
  EntrySetting,
  FieldKey,
  LEVEL_LABEL,
  Level,
  RATINGS_MASKED_HINT,
  RULE_VALUE_LABEL,
  SETTINGS,
  SETTING_LABEL,
  customFieldKey,
  defaultEntry,
  defaultLevel,
  isEntryField,
  isSetting,
  resolveEntry,
  resolveLevel,
  ruleSetting,
  validRule,
} from "@/domain/client-privacy";
import { OWNER_ROLE_KEY } from "@/domain/permissions";
import { guardPage } from "@/server/auth/staff";
import { lookupLimits } from "@/server/client-privacy";
import { CustomFields, LimitsForm, PersonRuleForm, RemoveRule, RuleCell } from "./editor";

export const metadata: Metadata = { title: "Client data protection" };

const TONE: Record<Level | Entry, "red" | "amber" | "green"> = { hidden: "red", masked: "amber", full: "green", allow: "green", deny: "red" };

const SETTING_HINT: Record<(typeof SETTINGS)[number], string> = {
  view: "Can view: how much of each detail the role sees.",
  add: "Can add: filling in a detail that's empty, on a new client, a booking, a walk-in or at checkout.",
  edit: "Can edit: replacing or clearing a detail that's already on file, even one they can't see.",
};

const entryText = (add: boolean, edit: boolean) => (add && edit ? "can add and edit" : add ? "can add, not edit" : edit ? "can edit, not add" : "can't add or edit");

export default async function ClientDataPage({ searchParams }: { searchParams: Promise<{ shop?: string; who?: string; setting?: string }> }) {
  const sp = await searchParams;
  await guardPage("/admin/client-data");
  const [roleRows, shopRows, fieldRows, ruleRows, people, limits] = await Promise.all([
    db.select({ id: roles.id, name: roles.name, key: roles.key }).from(roles).orderBy(asc(roles.sortOrder), asc(roles.name)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name)),
    db.select().from(clientFields).orderBy(asc(clientFields.sortOrder), asc(clientFields.label)),
    db.select().from(clientFieldRules),
    db
      .select({ id: staff.id, label: staff.displayLabel, roleId: staff.roleId, roleKey: roles.key, scope: staff.shopScope })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(and(eq(staff.active, true), eq(staff.kind, "person"), ne(roles.key, OWNER_ROLE_KEY)))
      .orderBy(asc(staff.displayLabel)),
    lookupLimits(),
  ]);
  const shopId = shopRows.some((s) => s.id === sp.shop) ? sp.shop! : null;
  const setting = isSetting(sp.setting) ? sp.setting : "view";
  const rules = ruleRows.filter(validRule);
  const custom = fieldRows.filter((f) => f.active);
  const fields: { key: FieldKey; label: string; hint: string }[] = [
    ...BUILTIN_FIELDS.map((f) => ({ key: f.key, label: f.label, hint: f.key === "ratings" ? RATINGS_MASKED_HINT : `Masked: ${f.example}` })),
    ...custom.map((f) => ({ key: customFieldKey(f.id), label: f.label, hint: "Masked: first letter" })),
  ];
  const gridFields = setting === "view" ? fields : fields.filter((f) => isEntryField(f.key));
  const editable = roleRows.filter((r) => r.key !== OWNER_ROLE_KEY);
  const owner = roleRows.find((r) => r.key === OWNER_ROLE_KEY);
  const shopName = (id: string | null) => (id ? (shopRows.find((s) => s.id === id)?.name ?? "—") : "All shops");
  const fieldName = (f: string) => fields.find((x) => x.key === f)?.label ?? fieldRows.find((x) => customFieldKey(x.id) === f)?.label ?? f;

  const cell = (role: (typeof roleRows)[number], field: FieldKey) => {
    const who = { staffId: "", roleId: role.id, roleKey: role.key };
    const same = (r: (typeof rules)[number]) => r.field === field && ruleSetting(r) === setting && r.roleId === role.id && !r.staffId;
    const own = rules.find((r) => same(r) && r.shopId === shopId);
    const rest = rules.filter((r) => r !== own);
    const inherited: Level | Entry = setting === "view" ? resolveLevel(rest, who, shopId, field) : resolveEntry(rest, who, shopId, field, setting) ? "allow" : "deny";
    const from = shopId && rules.some((r) => same(r) && r.shopId === null) ? "brand default" : "built-in";
    return { level: (own?.level as Level | Entry | undefined) ?? null, inherited, from };
  };

  const personRules = rules.filter((r) => r.staffId).map((r) => ({ ...r, who: people.find((p) => p.id === r.staffId)?.label ?? "Former staff" }));
  const who = people.find((p) => p.id === sp.who) ?? null;
  const whoShops = who
    ? await db.select({ shopId: staffAccessShops.shopId, roleId: staffAccessShops.roleId }).from(staffAccessShops).where(eq(staffAccessShops.staffId, who.id))
    : [];
  const whoColumns = who
    ? who.scope === "all" || !whoShops.length
      ? [{ shopId: null as string | null, roleId: who.roleId, roleKey: who.roleKey }]
      : whoShops.map((s) => {
          const r = s.roleId ? roleRows.find((x) => x.id === s.roleId) : null;
          return { shopId: s.shopId as string | null, roleId: r?.id ?? who.roleId, roleKey: r ? r.key : who.roleKey };
        })
    : [];
  const here = (p: { shop?: string | null; who?: string | null; setting?: (typeof SETTINGS)[number] }) => {
    const qs = new URLSearchParams();
    const s = p.shop === undefined ? shopId : p.shop;
    const w = p.who === undefined ? who?.id : p.who;
    const t = p.setting === undefined ? setting : p.setting;
    if (s) qs.set("shop", s);
    if (w) qs.set("who", w);
    if (t !== "view") qs.set("setting", t);
    return `/admin/client-data${qs.size ? `?${qs}` : ""}`;
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <PageHeader
        title="Client data protection"
        subtitle="Choose which client details each role and person sees (hidden, masked or in full) and, separately, which they can add or edit. Masking is applied on the server, so hidden details never reach their browser, exports or the app, even right after they've typed them in. Every change is in the audit log."
        actions={
          <LinkButton variant="secondary" href="/admin/client-data/access">
            Who viewed what
          </LinkButton>
        }
      />
      <Card>
        <CardHeader
          title="By role"
          subtitle={
            <>
              {shopId ? `Overrides at ${shopName(shopId)}. "Inherit" uses the brand default for the role.` : "Brand defaults for every shop. Pick a shop to override a role there."}{" "}
              {SETTING_HINT[setting]}
              <span className="mt-2 flex flex-wrap gap-1 text-xs">
                {SETTINGS.map((t) => (
                  <Link
                    key={t}
                    className={`rounded-full px-2.5 py-1 ring-1 ${setting === t ? "bg-brand-600 text-white ring-brand-600" : "text-zinc-700 ring-zinc-300"}`}
                    href={here({ setting: t })}
                  >
                    {SETTING_LABEL[t]}
                  </Link>
                ))}
              </span>
            </>
          }
          action={
            <div className="flex flex-wrap gap-1 text-xs">
              <Link className={`rounded-full px-2.5 py-1 ring-1 ${!shopId ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300"}`} href={here({ shop: null })}>
                Brand defaults
              </Link>
              {shopRows.map((s) => (
                <Link
                  key={s.id}
                  className={`rounded-full px-2.5 py-1 ring-1 ${shopId === s.id ? "bg-ink-900 text-white ring-ink-900" : "ring-zinc-300"}`}
                  href={here({ shop: s.id })}
                >
                  {s.name}
                </Link>
              ))}
            </div>
          }
        />
        <Table>
          <thead>
            <tr>
              <Th>Role</Th>
              {gridFields.map((f) => (
                <Th key={f.key} className="whitespace-normal px-1.5">
                  <span title={setting === "view" ? f.hint : undefined}>{f.label}</span>
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {owner && (
              <tr>
                <Td className="whitespace-nowrap font-medium">{owner.name}</Td>
                <td className="border-b border-zinc-100 px-3 py-2 text-xs text-zinc-500" colSpan={gridFields.length}>
                  {setting === "view" ? "Always sees every client detail in full." : "Can always add and edit every client detail."}
                </td>
              </tr>
            )}
            {editable.map((r) => (
              <tr key={r.id}>
                <Td className="whitespace-nowrap font-medium">{r.name}</Td>
                {gridFields.map((f) => {
                  const c = cell(r, f.key);
                  return (
                    <Td key={f.key} className="px-1.5">
                      <RuleCell rule={{ field: f.key, setting, roleId: r.id, staffId: null, shopId }} level={c.level} inherited={c.inherited} from={c.from} />
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="border-t border-zinc-100 px-4 py-3 text-xs text-zinc-500">
          {setting === "view" ? (
            <>
              Masked phone: ***-***-4321. Masked email: j***@gmail.com. Managers with &quot;reveal a masked client detail&quot; can show one detail at a time with a reason, and
              each reveal is logged. Search still finds a client by their full phone number or email without showing it, and calls and texts go through the shop line.
            </>
          ) : (
            <>
              Entering a detail doesn&apos;t let anyone see it: once saved it shows at their view level, and the save answers with the masked value or nothing. Someone who can edit
              a detail they can&apos;t see replaces it without the old value being shown. Ratings are left out; they come from the rating tools.
            </>
          )}
        </p>
      </Card>

      <Card>
        <CardHeader title="For one person" subtitle="A person's own rule beats their role's, and a rule at one shop beats a brand-wide one." />
        {personRules.length > 0 && (
          <Table>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Field</Th>
                <Th>Where</Th>
                <Th>Setting</Th>
                <Th>Level</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {personRules.map((r) => (
                <tr key={r.id}>
                  <Td>{r.who}</Td>
                  <Td>{fieldName(r.field)}</Td>
                  <Td>{shopName(r.shopId)}</Td>
                  <Td>{SETTING_LABEL[ruleSetting(r)]}</Td>
                  <Td>
                    <Badge tone={TONE[r.level]}>{RULE_VALUE_LABEL[r.level]}</Badge>
                  </Td>
                  <Td right>
                    <RemoveRule rule={{ field: r.field, setting: ruleSetting(r), roleId: null, staffId: r.staffId, shopId: r.shopId }} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <PersonRuleForm people={people.map((p) => ({ id: p.id, label: p.label }))} fields={fields.map((f) => ({ key: f.key, label: f.label }))} shops={shopRows} />
      </Card>

      <Card>
        <CardHeader
          title="What someone sees"
          subtitle="Pick a person to check the result of every rule for them: what they see, and what they can add or edit."
          action={
            <form action="/admin/client-data" className="flex gap-2">
              {shopId && <input type="hidden" name="shop" value={shopId} />}
              <select name="who" defaultValue={who?.id ?? ""} aria-label="Person" className="h-8 rounded-lg px-2 text-sm ring-1 ring-zinc-300">
                <option value="">Choose a person</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <button className="h-8 rounded-lg bg-ink-900 px-3 text-sm font-medium text-white">Check</button>
            </form>
          }
        />
        {who && (
          <Table>
            <thead>
              <tr>
                <Th>Field</Th>
                {whoColumns.map((c) => (
                  <Th key={c.shopId ?? "all"}>{shopName(c.shopId)}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.key}>
                  <Td>{f.label}</Td>
                  {whoColumns.map((c) => {
                    const w = { staffId: who.id, roleId: c.roleId, roleKey: c.roleKey };
                    const l = resolveLevel(rules, w, c.shopId, f.key);
                    const entry = (t: EntrySetting) => resolveEntry(rules, w, c.shopId, f.key, t);
                    const changed = l !== defaultLevel(c.roleKey, f.key) || (["add", "edit"] as const).some((t) => entry(t) !== defaultEntry(c.roleKey, f.key, t));
                    return (
                      <Td key={c.shopId ?? "all"}>
                        <Badge tone={TONE[l]}>{LEVEL_LABEL[l]}</Badge>
                        {isEntryField(f.key) && <span className="ml-1.5 text-xs text-zinc-600">{entryText(entry("add"), entry("edit"))}</span>}
                        {changed && <span className="ml-1 text-[11px] text-zinc-400">set</span>}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Custom client fields"
            subtitle="Extra details your shops keep on clients. Each gets its own column above; new fields start hidden from barbers and masked for the front desk."
          />
          <CustomFields fields={fieldRows.map((f) => ({ id: f.id, label: f.label, active: f.active }))} />
        </Card>
        <Card>
          <CardHeader
            title="Unusual lookups"
            subtitle="Opening many client profiles or running many searches in a short time alerts the brand admins, and past the limit pauses that person's lookups. The Brand Owner is never paused."
          />
          <LimitsForm initial={limits} />
        </Card>
      </div>
    </div>
  );
}
