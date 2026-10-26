"use client";

import { Fragment, useState } from "react";
import { useBrandSync } from "@/components/brand-sync";
import { Badge, Button, Card, CardHeader, Input, Select, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { DEFAULT_FIELDS, DEFAULT_SECTIONS, DefaultKey, DefaultSection, DefaultValue, Effective, LocationDefaults, formatDefault, keysIn } from "@/domain/location-defaults";
import { clearShopOverrideAction, setShopOverrideAction } from "./actions";

type Shop = { shopId: string; shop: string; effective: Effective };
type Pick = { key: DefaultKey; shopId: string | null };

export function DefaultsBoard({
  brand,
  shops,
  roles,
  canBrand,
  shopSections,
}: {
  brand: LocationDefaults;
  shops: Shop[];
  roles: { key: string; name: string }[];
  canBrand: boolean;
  /** Sections they may give a location its own value in. */
  shopSections: DefaultSection[];
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const show = (key: DefaultKey, v: DefaultValue) => (DEFAULT_FIELDS[key].kind === "role" ? (roles.find((r) => r.key === v)?.name ?? String(v)) : formatDefault(key, v));
  return (
    <div className="space-y-5">
      {DEFAULT_SECTIONS.map((sec) => {
        const keys = keysIn(sec.id);
        const shopEdit = shopSections.includes(sec.id);
        return (
          <Card key={sec.id}>
            <CardHeader title={sec.label} subtitle={sec.hint} />
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm" data-testid={`defaults-${sec.id}`}>
                <thead>
                  <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500">
                    <th className="px-3 py-2">Setting</th>
                    <th className="px-3 py-2">Brand (all shops)</th>
                    {shops.map((s) => (
                      <th key={s.shopId} className="px-3 py-2">
                        {s.shop}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {keys.map((key) => {
                    const f = DEFAULT_FIELDS[key];
                    const open = pick?.key === key;
                    return (
                      <Fragment key={key}>
                        <tr className={cx("border-b border-zinc-100 align-top", open && "bg-zinc-50")}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{f.label}</div>
                            {f.hint && <div className="text-xs text-zinc-500">{f.hint}</div>}
                          </td>
                          <td className="px-3 py-2">
                            <Cell selected={open && pick?.shopId === null} disabled={!canBrand} onClick={() => setPick(open && pick?.shopId === null ? null : { key, shopId: null })}>
                              <span className="font-medium">{show(key, brand[key])}</span>
                            </Cell>
                          </td>
                          {shops.map((s) => {
                            const e = s.effective[key];
                            const sel = open && pick?.shopId === s.shopId;
                            return (
                              <td key={s.shopId} className="px-3 py-2">
                                <Cell selected={sel} disabled={!shopEdit} onClick={() => setPick(sel ? null : { key, shopId: s.shopId })}>
                                  <span className={e.scope === "shop" ? "font-medium" : "text-zinc-500"}>{show(key, e.value)}</span>
                                  <div>
                                    <Badge tone={e.scope === "shop" ? "violet" : "gray"} className="mt-0.5 text-[10px]">
                                      {e.scope === "shop" ? "this shop only" : "all shops"}
                                    </Badge>
                                  </div>
                                </Cell>
                              </td>
                            );
                          })}
                        </tr>
                        {open && pick && (
                          <tr className="border-b border-zinc-200 bg-zinc-50">
                            <td colSpan={shops.length + 2} className="px-3 pb-3 pt-1">
                              <Editor
                                key={`${pick.key}:${pick.shopId}`}
                                k={key}
                                shop={pick.shopId ? shops.find((s) => s.shopId === pick.shopId)! : null}
                                brandValue={brand[key]}
                                brandLabel={show(key, brand[key])}
                                following={shops.filter((s) => s.effective[key].scope === "all").length}
                                roles={roles}
                                onDone={() => setPick(null)}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Cell({ selected, disabled, onClick, children }: { selected: boolean; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  if (disabled) return <div>{children}</div>;
  return (
    <button type="button" onClick={onClick} className={cx("w-full rounded-md px-2 py-1 text-left hover:bg-white hover:ring-1 hover:ring-zinc-300", selected && "bg-white ring-2 ring-ink-900")}>
      {children}
    </button>
  );
}

const toInput = (key: DefaultKey, v: DefaultValue) => (v === null ? "" : DEFAULT_FIELDS[key].kind === "cents" ? (Number(v) / 100).toFixed(2) : String(v));
function fromInput(key: DefaultKey, s: string): unknown {
  switch (DEFAULT_FIELDS[key].kind) {
    case "minutes":
    case "days":
    case "hours":
      return s.trim() === "" ? NaN : Number(s);
    case "cents":
      return Math.round(Number(s) * 100);
    default:
      return s;
  }
}

function Editor({
  k,
  shop,
  brandValue,
  brandLabel,
  following,
  roles,
  onDone,
}: {
  k: DefaultKey;
  shop: Shop | null;
  brandValue: DefaultValue;
  brandLabel: string;
  following: number;
  roles: { key: string; name: string }[];
  onDone: () => void;
}) {
  const f = DEFAULT_FIELDS[k];
  const current = shop ? shop.effective[k].value : brandValue;
  const own = shop?.effective[k].scope === "shop";
  const [v, setV] = useState(toInput(k, current));
  const { pending: running, error, run } = useAction();
  const sync = useBrandSync();
  const pending = running || sync.pending;
  const input =
    f.kind === "hours" ? (
      <Select className="w-40 py-1.5" value={v} onChange={(e) => setV(e.target.value)} aria-label={f.label}>
        {(f.options ?? []).map((h) => (
          <option key={h} value={h}>
            {h === 0 ? "Off" : `${h} hours before`}
          </option>
        ))}
      </Select>
    ) : f.kind === "role" ? (
      <Select className="w-48 py-1.5" value={v} onChange={(e) => setV(e.target.value)} aria-label={f.label}>
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name}
          </option>
        ))}
      </Select>
    ) : f.kind === "longtext" ? (
      <textarea className="w-full max-w-xl rounded-md border border-zinc-300 px-2 py-1.5 text-sm" rows={3} maxLength={500} value={v} onChange={(e) => setV(e.target.value)} aria-label={f.label} />
    ) : (
      <div className="flex items-center gap-2">
        {f.kind === "color" && <span className="h-6 w-6 rounded ring-1 ring-zinc-300" style={{ background: /^#[0-9a-fA-F]{6}$/.test(v) ? v : "transparent" }} />}
        <Input
          className="w-56 py-1.5"
          inputMode={f.kind === "minutes" || f.kind === "days" ? "numeric" : f.kind === "cents" ? "decimal" : undefined}
          placeholder={f.kind === "color" ? "#c81e1e" : f.kind === "id" ? f.hint : undefined}
          value={v}
          onChange={(e) => setV(e.target.value)}
          aria-label={f.label}
        />
      </div>
    );
  return (
    <div className="rounded-lg bg-white p-3 ring-1 ring-zinc-200">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {f.label} · {shop ? shop.shop : "brand default"}
      </div>
      {input}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {shop ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => run(() => setShopOverrideAction(shop.shopId, k, fromInput(k, v)), onDone)}>
              Save for this shop only
            </Button>
            {own && (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => clearShopOverrideAction(shop.shopId, k), onDone)}>
                Use the brand value ({brandLabel})
              </Button>
            )}
          </>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => void sync.open({ label: f.label, changes: [{ type: "location_default", item: k, value: fromInput(k, v) }], onDone })}>
            Save to brand…
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <span className="text-xs text-zinc-500">
          {shop
            ? own
              ? "This shop has its own value. Brand changes won't reach it until you switch it back."
              : "This shop follows the brand. Saving gives it its own value."
            : `${following} shop${following === 1 ? "" : "s"} follow the brand. Next you pick which shops it goes to; shops with their own value keep it unless you replace it.`}
        </span>
      </div>
      {(error ?? sync.error) && <div className="mt-2 text-xs text-red-600">{error ?? sync.error}</div>}
      {sync.dialog}
    </div>
  );
}
