"use client";

import type { ReactNode } from "react";
import { Chips, ItemPicker, toggle } from "@/components/chips";
import { Field, Input, Select, cx } from "@/components/ui";
import type { FilterOptions, PanelSees } from "@/domain/client-filters";
import {
  CHANNELS,
  CHANNEL_LABEL,
  FILTER_FIELDS,
  GIFT_CARD_FILTERS,
  GIFT_CARD_FILTER_LABEL,
  TRI,
  filterFieldReads,
  type FilterField,
  type Segment,
  type Tri,
} from "@/domain/marketing";
import { BarberFilter, LastVisitFilter } from "@/app/admin/campaign-center/segment-fields";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const num = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Math.max(0, Math.round(Number(s))));
const cents = (s: string) => (s.trim() === "" || !Number.isFinite(Number(s)) ? null : Math.max(0, Math.round(Number(s) * 100)));
const dollars = (c: number | null) => (c === null ? "" : String(c / 100));
const str = (n: number | null) => (n === null ? "" : String(n));
const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);
const RANK = { hidden: 0, masked: 1, full: 2 } as const;

function Section({ title, count, open, children }: { title: string; count: number; open?: boolean; children: ReactNode }) {
  return (
    <details className="group rounded-lg ring-1 ring-zinc-200" open={open || count > 0}>
      <summary className="flex cursor-pointer select-none items-center justify-between px-3 py-2 text-sm font-medium text-zinc-800">
        <span>
          {title}
          {count > 0 && <span className="ml-2 rounded-full bg-brand-600 px-1.5 py-px text-[11px] font-semibold text-white">{count}</span>}
        </span>
        <span className="text-xs text-zinc-400 group-open:rotate-180">▾</span>
      </summary>
      <div className="space-y-3 border-t border-zinc-100 p-3">{children}</div>
    </details>
  );
}

function TriSelect({ label, value, onChange, disabled, yes = "Yes", no = "No" }: { label: string; value: Tri; onChange: (v: Tri) => void; disabled?: boolean; yes?: string; no?: string }) {
  return (
    <Field label={label}>
      <Select disabled={disabled} value={value} onChange={(e) => onChange(e.target.value as Tri)}>
        {TRI.map((t) => (
          <option key={t} value={t}>
            {t === "any" ? "Either" : t === "yes" ? yes : no}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function Range({ label, lo, hi, onLo, onHi, disabled, money }: { label: string; lo: number | null; hi: number | null; onLo: (v: number | null) => void; onHi: (v: number | null) => void; disabled?: boolean; money?: boolean }) {
  const show = money ? dollars : str;
  const read = money ? cents : num;
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <Input inputMode="decimal" aria-label={`${label}, at least`} placeholder="Min" disabled={disabled} value={show(lo)} onChange={(e) => onLo(read(e.target.value))} />
        <span className="text-xs text-zinc-400">to</span>
        <Input inputMode="decimal" aria-label={`${label}, at most`} placeholder="Max" disabled={disabled} value={show(hi)} onChange={(e) => onHi(read(e.target.value))} />
      </div>
    </Field>
  );
}

function Dates({ label, from, to, onChange, disabled }: { label: string; from: string | null; to: string | null; onChange: (from: string | null, to: string | null) => void; disabled?: boolean }) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <Input type="date" aria-label={`${label} from`} disabled={disabled} value={from ?? ""} onChange={(e) => onChange(e.target.value || null, to)} />
        <span className="text-xs text-zinc-400">to</span>
        <Input type="date" aria-label={`${label} to`} disabled={disabled} value={to ?? ""} onChange={(e) => onChange(from, e.target.value || null)} />
      </div>
    </Field>
  );
}

/** Comma-separated text, kept as typed until it's left so commas can be typed. */
function ListInput({ value, onChange, disabled, placeholder, label }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; label: string }) {
  return (
    <Field label={label}>
      <Input key={value.join(",")} disabled={disabled} placeholder={placeholder} defaultValue={value.join(", ")} onBlur={(e) => onChange(list(e.target.value))} />
    </Field>
  );
}

/**
 * Every client filter: Campaign Center segments and the client list share them. Filters on a
 * detail the person doesn't see (enough of) aren't offered, and the server refuses them anyway.
 */
export function SegmentFilters({
  seg,
  onChange,
  options,
  sees,
  disabled,
  campaign,
}: {
  seg: Segment;
  onChange: (x: Partial<Segment>) => void;
  options: FilterOptions;
  sees: PanelSees;
  disabled?: boolean;
  /** In a blast: the "agreed to" channel filter; locations are picked separately. */
  campaign?: boolean;
}) {
  const at = (f: string, want: keyof typeof RANK) => RANK[sees.levels[f] ?? "hidden"] >= RANK[want];
  const s = onChange;
  const ro = disabled;
  const set = (...v: unknown[]) => v.filter((x) => (Array.isArray(x) ? x.length > 0 : x !== null && x !== "any" && x !== false)).length;
  const nullable = [...(Object.keys(FILTER_FIELDS) as FilterField[]), ...options.customFields.map((f) => `custom:${f.id}` as FilterField)].filter((f) => {
    const reads = filterFieldReads(f);
    return !reads || at(reads, "masked");
  });
  const fieldName = (f: string) => (f.startsWith("custom:") ? (options.customFields.find((c) => `custom:${c.id}` === f)?.name ?? "Custom field") : FILTER_FIELDS[f as keyof typeof FILTER_FIELDS].label);
  return (
    <div className="space-y-3" data-testid="segment-filters">
      <Section
        title="Visit history"
        open
        count={set(
          seg.lastVisitOverDays,
          seg.lastVisitWithinDays,
          seg.notBooked,
          seg.lastVisitFrom,
          seg.lastVisitTo,
          seg.firstVisitFrom,
          seg.firstVisitTo,
          seg.firstVisitWithinDays,
          seg.firstVisitOverDays,
          seg.minVisits,
          seg.maxVisits,
          seg.minNoShows,
          seg.maxNoShows,
          seg.minCancellations,
          seg.maxCancellations,
          seg.minAvgGapDays,
          seg.maxAvgGapDays,
          seg.upcoming,
        )}
      >
        <LastVisitFilter seg={seg} disabled={ro} onChange={s} />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Dates label="Last visit between" from={seg.lastVisitFrom} to={seg.lastVisitTo} disabled={ro} onChange={(lastVisitFrom, lastVisitTo) => s({ lastVisitFrom, lastVisitTo })} />
          <Dates label="First visit between" from={seg.firstVisitFrom} to={seg.firstVisitTo} disabled={ro} onChange={(firstVisitFrom, firstVisitTo) => s({ firstVisitFrom, firstVisitTo })} />
          <Field label="First visit within (days)">
            <Input inputMode="numeric" disabled={ro} value={str(seg.firstVisitWithinDays)} onChange={(e) => s({ firstVisitWithinDays: num(e.target.value) })} />
          </Field>
          <Range label="Visits" lo={seg.minVisits} hi={seg.maxVisits} disabled={ro} onLo={(minVisits) => s({ minVisits })} onHi={(maxVisits) => s({ maxVisits })} />
          <Range label="No-shows" lo={seg.minNoShows} hi={seg.maxNoShows} disabled={ro} onLo={(minNoShows) => s({ minNoShows })} onHi={(maxNoShows) => s({ maxNoShows })} />
          <Range label="Cancellations" lo={seg.minCancellations} hi={seg.maxCancellations} disabled={ro} onLo={(minCancellations) => s({ minCancellations })} onHi={(maxCancellations) => s({ maxCancellations })} />
          <Range label="Average days between visits" lo={seg.minAvgGapDays} hi={seg.maxAvgGapDays} disabled={ro} onLo={(minAvgGapDays) => s({ minAvgGapDays })} onHi={(maxAvgGapDays) => s({ maxAvgGapDays })} />
          <TriSelect label="Upcoming appointment" value={seg.upcoming} disabled={ro} yes="Has one booked" no="Nothing booked" onChange={(upcoming) => s({ upcoming })} />
        </div>
      </Section>

      <Section title="Barbers and locations" count={set(seg.staffIds, seg.homeShopIds, seg.visitedShopIds)}>
        <BarberFilter seg={seg} barbers={options.barbers} disabled={ro} seesPreferred={at("preferred_barber", "masked")} onChange={s} />
        {options.shops.length > 1 && (
          <>
            <Field label="Home location">
              <Chips disabled={ro} options={options.shops} selected={seg.homeShopIds} onToggle={(x) => s({ homeShopIds: toggle(seg.homeShopIds, x) })} />
            </Field>
            <Field label="Visited">
              <Chips disabled={ro} options={options.shops} selected={seg.visitedShopIds} onToggle={(x) => s({ visitedShopIds: toggle(seg.visitedShopIds, x) })} />
            </Field>
          </>
        )}
      </Section>

      <Section
        title="Spend"
        count={set(seg.serviceIds, ...(sees.money ? [seg.minSpendCents, seg.maxSpendCents, seg.minAvgTicketCents, seg.maxAvgTicketCents, seg.minTipsCents, seg.maxTipsCents] : []))}
      >
        <Field label="Bought any of these services or products">
          <ItemPicker disabled={ro} placeholder="Search services and products" options={options.items} selected={seg.serviceIds} onChange={(serviceIds) => s({ serviceIds })} />
        </Field>
        {sees.money ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Range money label="Total spend ($)" lo={seg.minSpendCents} hi={seg.maxSpendCents} disabled={ro} onLo={(minSpendCents) => s({ minSpendCents })} onHi={(maxSpendCents) => s({ maxSpendCents })} />
            <Range money label="Average ticket ($)" lo={seg.minAvgTicketCents} hi={seg.maxAvgTicketCents} disabled={ro} onLo={(minAvgTicketCents) => s({ minAvgTicketCents })} onHi={(maxAvgTicketCents) => s({ maxAvgTicketCents })} />
            <Range money label="Total tips ($)" lo={seg.minTipsCents} hi={seg.maxTipsCents} disabled={ro} onLo={(minTipsCents) => s({ minTipsCents })} onHi={(maxTipsCents) => s({ maxTipsCents })} />
          </div>
        ) : (
          <p className="text-xs text-zinc-500">Spend and tip filters need access to every client.</p>
        )}
      </Section>

      <Section title="Loyalty, gift cards and coupons" count={set(seg.minLoyaltyCents, seg.maxLoyaltyCents, sees.money ? seg.giftCard : null, seg.couponRedeemed, seg.promoIds)}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Range money label="Loyalty rewards available ($)" lo={seg.minLoyaltyCents} hi={seg.maxLoyaltyCents} disabled={ro} onLo={(minLoyaltyCents) => s({ minLoyaltyCents })} onHi={(maxLoyaltyCents) => s({ maxLoyaltyCents })} />
          {sees.money && (
            <Field label="Gift card">
              <Select disabled={ro} value={seg.giftCard} onChange={(e) => s({ giftCard: e.target.value as Segment["giftCard"] })}>
                {GIFT_CARD_FILTERS.map((g) => (
                  <option key={g} value={g}>
                    {GIFT_CARD_FILTER_LABEL[g]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <TriSelect label="Redeemed a coupon" value={seg.couponRedeemed} disabled={ro} onChange={(couponRedeemed) => s({ couponRedeemed })} />
        </div>
        {seg.couponRedeemed !== "any" && options.promos.length > 0 && (
          <Field label="Of these coupons (none picked: any coupon)">
            <ItemPicker disabled={ro} placeholder="Search coupons" options={options.promos} selected={seg.promoIds} onChange={(promoIds) => s({ promoIds })} />
          </Field>
        )}
      </Section>

      <Section
        title="Profile"
        count={set(
          seg.minRating,
          seg.maxRating,
          seg.tags,
          seg.excludeTags,
          seg.birthdayMonths,
          seg.birthdayWithinDays,
          seg.minAge,
          seg.maxAge,
          seg.zips,
          seg.cities,
          seg.near,
          seg.sources,
          seg.referred,
          seg.createdFrom,
          seg.createdTo,
        )}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {at("ratings", "masked") && (
            <Range
              label="Staff rating (1–5)"
              lo={seg.minRating}
              hi={seg.maxRating}
              disabled={ro}
              onLo={(v) => s({ minRating: v === null ? null : Math.min(5, Math.max(1, v)) })}
              onHi={(v) => s({ maxRating: v === null ? null : Math.min(5, Math.max(1, v)) })}
            />
          )}
          {at("birthday", "full") && (
            <>
              <Field label="Birthday in the next (days)">
                <Input inputMode="numeric" disabled={ro} value={str(seg.birthdayWithinDays)} onChange={(e) => s({ birthdayWithinDays: num(e.target.value) })} />
              </Field>
              <Range label="Age" lo={seg.minAge} hi={seg.maxAge} disabled={ro} onLo={(minAge) => s({ minAge })} onHi={(maxAge) => s({ maxAge })} />
            </>
          )}
          <Dates label="Client since" from={seg.createdFrom} to={seg.createdTo} disabled={ro} onChange={(createdFrom, createdTo) => s({ createdFrom, createdTo })} />
          <TriSelect label="Referred by a client" value={seg.referred} disabled={ro} onChange={(referred) => s({ referred })} />
        </div>
        {at("birthday", "masked") && (
          <Field label="Birthday in">
            <Chips
              disabled={ro}
              options={MONTHS.map((m, i) => ({ id: String(i + 1), name: m }))}
              selected={seg.birthdayMonths.map(String)}
              onToggle={(x) => s({ birthdayMonths: toggle(seg.birthdayMonths, Number(x)).sort((a, b) => a - b) })}
            />
          </Field>
        )}
        {options.tags.length > 0 && (
          <>
            <Field label="Tagged any of">
              <Chips disabled={ro} options={options.tags.map((t) => ({ id: t, name: t }))} selected={seg.tags} onToggle={(x) => s({ tags: toggle(seg.tags, x) })} />
            </Field>
            <Field label="Not tagged">
              <Chips disabled={ro} options={options.tags.map((t) => ({ id: t, name: t }))} selected={seg.excludeTags} onToggle={(x) => s({ excludeTags: toggle(seg.excludeTags, x) })} />
            </Field>
          </>
        )}
        {options.sources.length > 0 && (
          <Field label="Found us through">
            <Chips disabled={ro} options={options.sources.map((t) => ({ id: t, name: t }))} selected={seg.sources} onToggle={(x) => s({ sources: toggle(seg.sources, x) })} />
          </Field>
        )}
        {at("address", "masked") ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <ListInput label="Zip codes" placeholder="52241, 52240" value={seg.zips} disabled={ro} onChange={(v) => s({ zips: v.filter((z) => /^\d{5}$/.test(z)) })} />
            <ListInput label="Towns" placeholder="Coralville, Iowa City" value={seg.cities} disabled={ro} onChange={(v) => s({ cities: v.map((c) => c.toLowerCase()) })} />
            <Field label="Lives within">
              <div className="flex items-center gap-1.5">
                <Input
                  inputMode="numeric"
                  aria-label="Miles"
                  className="w-20"
                  disabled={ro || !options.shops.length}
                  value={seg.near ? String(seg.near.miles) : ""}
                  onChange={(e) => {
                    const miles = num(e.target.value);
                    s({ near: miles ? { shopId: seg.near?.shopId ?? options.shops[0].id, miles: Math.min(500, miles) } : null });
                  }}
                />
                <span className="shrink-0 text-xs text-zinc-500">miles of</span>
                <Select aria-label="Location" disabled={ro || !seg.near} value={seg.near?.shopId ?? options.shops[0]?.id ?? ""} onChange={(e) => seg.near && s({ near: { ...seg.near, shopId: e.target.value } })}>
                  {options.shops.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </Select>
              </div>
            </Field>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">Where-they-live filters need client addresses, which are hidden from you.</p>
        )}
      </Section>

      <Section
        title="Messaging"
        count={set(
          campaign && seg.channel !== "any" ? seg.channel : null,
          seg.smsOptIn,
          seg.emailOptIn,
          seg.smsMarketing,
          seg.emailMarketing,
          seg.pushMarketing,
          seg.reviewClicked,
          seg.campaignReceived,
          seg.campaignClicked,
        )}
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {campaign && (
            <Field label="Agreed to">
              <Select disabled={ro} value={seg.channel} onChange={(e) => s({ channel: e.target.value as Segment["channel"] })}>
                <option value="any">Any channel</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {CHANNEL_LABEL[c]} only
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <TriSelect label="Appointment texts" value={seg.smsOptIn} disabled={ro} yes="Agreed" no="Not agreed" onChange={(smsOptIn) => s({ smsOptIn })} />
          <TriSelect label="Appointment emails" value={seg.emailOptIn} disabled={ro} yes="Agreed" no="Not agreed" onChange={(emailOptIn) => s({ emailOptIn })} />
          <TriSelect label="Marketing texts" value={seg.smsMarketing} disabled={ro} yes="Opted in" no="Not opted in" onChange={(smsMarketing) => s({ smsMarketing })} />
          <TriSelect label="Marketing emails" value={seg.emailMarketing} disabled={ro} yes="Opted in" no="Not opted in" onChange={(emailMarketing) => s({ emailMarketing })} />
          <TriSelect label="App push" value={seg.pushMarketing} disabled={ro} yes="Opted in" no="Not opted in" onChange={(pushMarketing) => s({ pushMarketing })} />
          <TriSelect label="Clicked a review link" value={seg.reviewClicked} disabled={ro} onChange={(reviewClicked) => s({ reviewClicked })} />
          <TriSelect label="Got a campaign message" value={seg.campaignReceived} disabled={ro} onChange={(campaignReceived) => s({ campaignReceived })} />
          <TriSelect label="Clicked a campaign link" value={seg.campaignClicked} disabled={ro} onChange={(campaignClicked) => s({ campaignClicked })} />
        </div>
        {(seg.campaignReceived !== "any" || seg.campaignClicked !== "any") && options.campaigns.length > 0 && (
          <Field label="From these campaigns (none picked: any campaign)">
            <ItemPicker disabled={ro} placeholder="Search campaigns" options={options.campaigns} selected={seg.campaignIds} onChange={(campaignIds) => s({ campaignIds })} />
          </Field>
        )}
      </Section>

      <Section title="Filled in or empty" count={set(seg.fieldsSet, seg.fieldsEmpty)}>
        <p className="text-xs text-zinc-500">Find records to clean up, or clients you can reach. Only details you can see are offered.</p>
        <div className="flex flex-wrap gap-1.5">
          {nullable.map((f) => {
            const state = seg.fieldsSet.includes(f) ? "set" : seg.fieldsEmpty.includes(f) ? "empty" : null;
            const next = state === null ? "set" : state === "set" ? "empty" : null;
            return (
              <button
                key={f}
                type="button"
                disabled={ro}
                title="Click: filled in, again: empty, again: either"
                onClick={() => s({ fieldsSet: next === "set" ? [...seg.fieldsSet, f] : seg.fieldsSet.filter((x) => x !== f), fieldsEmpty: next === "empty" ? [...seg.fieldsEmpty, f] : seg.fieldsEmpty.filter((x) => x !== f) })}
                className={cx(
                  "rounded-full px-2.5 py-1 text-xs ring-1",
                  state === "set" ? "bg-emerald-600 text-white ring-emerald-600" : state === "empty" ? "bg-amber-500 text-white ring-amber-500" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500",
                )}
              >
                {fieldName(f)}
                {state === "set" ? ": filled in" : state === "empty" ? ": empty" : ""}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
