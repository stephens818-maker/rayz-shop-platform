"use client";

import { Fragment, useState } from "react";
import { ClientBadge } from "@/components/client-badges";
import { SegmentFilters } from "@/components/segment-filters";
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea, cx } from "@/components/ui";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { useAction } from "@/components/use-action";
import type { FilterOptions, PanelSees } from "@/domain/client-filters";
import {
  BADGES,
  BADGE_GROUPS,
  BADGE_GROUP_LABEL,
  BADGE_ICONS,
  BADGE_TONES,
  BADGE_TONE_LABEL,
  THRESHOLD_LABEL,
  customBadgeProblem,
  customKey,
  roleSeesBadge,
  type BadgeIcon,
  type BadgeRole,
  type BadgeSettings,
  type BadgeThresholds,
  type BadgeTone,
  type CustomBadge,
} from "@/domain/badges";
import { NOTIFY_DEFAULT, canNotify, customerMayShow, customerSetting, type BadgeChange } from "@/domain/customer-badges";
import { EMPTY_SEGMENT, type Segment } from "@/domain/marketing";
import { deleteCustomBadgeAction, recomputeBadgesAction, saveCustomBadgeAction } from "./actions";

type Role = BadgeRole & { name: string };
type Row = { key: string; label: string; icon: BadgeIcon; tone: BadgeTone; hint: string; sensitive?: boolean; money?: boolean; filter?: Segment };

export function BadgeSettingsEditor({ initial, roles, custom, readOnly }: { initial: BadgeSettings; roles: Role[]; custom: CustomBadge[]; readOnly?: boolean }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("badges");
  const [s, setS] = useState(initial);
  const [base, setBase] = useState(initial);
  const dirty = JSON.stringify(s) !== JSON.stringify(base);
  const on = (key: string) => !(s.off as string[]).includes(key);
  const setOn = (key: string, v: boolean) => setS((x) => ({ ...x, off: v ? x.off.filter((k) => k !== key) : ([...x.off, key] as BadgeSettings["off"]) }));
  const setRole = (key: string, roleId: string, v: boolean) => setS((x) => ({ ...x, roles: { ...x.roles, [key]: { ...x.roles[key], [roleId]: v } } }));
  const custom_ = (b: Row) => (b.filter ? { filter: b.filter } : null);
  const setCustomer = (key: string, v: boolean) => setS((x) => ({ ...x, customer: { ...x.customer, [key]: v } }));
  const notifyOn = (key: string, c: BadgeChange) => s.notify[key]?.[c] ?? (c === "earned" && NOTIFY_DEFAULT.has(key));
  const setNotify = (key: string, c: BadgeChange, v: boolean) =>
    setS((x) => ({ ...x, notify: { ...x.notify, [key]: { earned: notifyOn(key, "earned"), lost: notifyOn(key, "lost"), [c]: v } } }));
  const setT = (k: keyof BadgeThresholds, v: string) => setS((x) => ({ ...x, thresholds: { ...x.thresholds, [k]: Number(v) } }));
  const groups = BADGE_GROUPS.map((g) => ({
    g,
    rows:
      g === "custom"
        ? custom.map((c): Row => ({ key: customKey(c.id), label: c.label, icon: c.icon, tone: c.tone, hint: c.tooltip || "Custom badge", filter: c.filter }))
        : (BADGES as readonly (Row & { group: string })[]).filter((b) => b.group === g),
  })).filter((x) => x.rows.length);

  return (
    <Card>
      <CardHeader
        title="Badges"
        subtitle="Which badges show, to which roles, and which customers see in their account and the app. Spend badges start shown to brand-level roles only; staff judgments like Low rating never show to customers."
      />
      <div className="space-y-4 px-4 py-3">
        <label className="flex items-center gap-2 text-sm font-medium text-zinc-900">
          <input type="checkbox" checked={s.enabled} onChange={(e) => setS({ ...s, enabled: e.target.checked })} data-testid="badges-enabled" />
          Client badges are on
        </label>
        <fieldset disabled={!s.enabled} className="disabled:opacity-50">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="badge-matrix">
              <thead>
                <tr className="text-left text-xs text-zinc-500">
                  <th className="py-1 pr-2 font-medium">Badge</th>
                  <th className="px-1 py-1 text-center font-medium">On</th>
                  <th className="px-1 py-1 text-center font-medium whitespace-nowrap">Customers see</th>
                  <th className="px-1 py-1 text-center font-medium whitespace-nowrap" title="A Badge news message when a customer earns or loses it">
                    Message
                  </th>
                  {roles.map((r) => (
                    <th key={r.id} className="px-1 py-1 text-center font-medium whitespace-nowrap">
                      {r.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {groups.map(({ g, rows }) => (
                  <Fragment key={g}>
                    <tr>
                      <td colSpan={roles.length + 4} className="pt-3 pb-1 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
                        {BADGE_GROUP_LABEL[g]}
                      </td>
                    </tr>
                    {rows.map((b) => (
                      <tr key={b.key} className="border-t border-zinc-100 align-top">
                        <td className="py-1.5 pr-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <ClientBadge badge={{ ...b, tip: b.hint }} />
                            {b.sensitive && <Badge tone="amber">Sensitive</Badge>}
                            {b.money && <Badge tone="gray">Spend</Badge>}
                          </div>
                          <div className="mt-0.5 max-w-md text-xs text-zinc-500">{b.hint}</div>
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          {g === "custom" ? (
                            <span className="text-xs text-zinc-400">below</span>
                          ) : (
                            <input type="checkbox" aria-label={`${b.label} on`} checked={on(b.key)} onChange={(e) => setOn(b.key, e.target.checked)} />
                          )}
                        </td>
                        <td className="px-1 py-1.5 text-center">
                          {customerMayShow(b.key, custom_(b)) ? (
                            <input
                              type="checkbox"
                              aria-label={`${b.label} for customers`}
                              disabled={!on(b.key)}
                              checked={customerSetting(s, b.key, custom_(b))}
                              onChange={(e) => setCustomer(b.key, e.target.checked)}
                              data-testid={`customer-${b.key}`}
                            />
                          ) : (
                            <span className="text-xs text-zinc-400" title="A staff judgment, or built on staff ratings: never shown to customers">
                              Staff only
                            </span>
                          )}
                        </td>
                        <td className="px-1 py-1.5 text-center whitespace-nowrap">
                          {on(b.key) && customerSetting(s, b.key, custom_(b)) ? (
                            <span className="inline-flex gap-2 text-xs text-zinc-600">
                              {(["earned", "lost"] as const)
                                .filter((c) => canNotify(b.key, c))
                                .map((c) => (
                                  <label key={c} className="inline-flex items-center gap-1">
                                    <input type="checkbox" aria-label={`Message when ${b.label} is ${c}`} checked={notifyOn(b.key, c)} onChange={(e) => setNotify(b.key, c, e.target.checked)} />
                                    {c === "earned" ? "Earned" : "Lost"}
                                  </label>
                                ))}
                            </span>
                          ) : (
                            <span className="text-xs text-zinc-300">—</span>
                          )}
                        </td>
                        {roles.map((r) => (
                          <td key={r.id} className="px-1 py-1.5 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${b.label} for ${r.name}`}
                              disabled={!on(b.key)}
                              checked={roleSeesBadge(s, b.key, r)}
                              onChange={(e) => setRole(b.key, r.id, e.target.checked)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </fieldset>
        <p className="text-xs text-zinc-500">
          Messages go out as the Campaign Center&apos;s <a className="underline" href="/admin/campaign-center">Badge news</a> automation, once each location turns it on: only to customers who agreed to marketing on
          that channel, within the brand&apos;s weekly and monthly caps and the automation&apos;s own one-per-N-days, never in quiet hours.
        </p>
        <div>
          <h3 className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Thresholds</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {(Object.keys(THRESHOLD_LABEL) as (keyof BadgeThresholds)[]).map((k) => (
              <Field key={k} label={THRESHOLD_LABEL[k].label} hint={THRESHOLD_LABEL[k].unit}>
                <Input type="number" step={k === "lowRatingBelow" ? 0.5 : 1} value={s.thresholds[k]} onChange={(e) => setT(k, e.target.value)} data-testid={`threshold-${k}`} />
              </Field>
            ))}
          </div>
        </div>
        <SyncMsg msg={msg} className="block text-sm" />
        {readOnly ? (
          <p className="text-sm text-zinc-500">Set by the brand for every shop.</p>
        ) : (
          <Button disabled={pending || !dirty} onClick={() => saveSetting(s, () => setBase(s))}>
            Save
          </Button>
        )}
      </div>
      {dialog}
    </Card>
  );
}

export function RecomputeButton() {
  const { pending, error, run } = useAction();
  const [done, setDone] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(recomputeBadgesAction, (r) => setDone(r.remaining ? `${r.scanned} done, ${r.remaining} left for tonight` : `${r.scanned} done`))}>
        {pending ? "Working…" : "Recompute now"}
      </Button>
      {error && <p className="text-xs text-red-700">{error}</p>}
      {done && <p className="text-xs text-emerald-700">{done}</p>}
    </div>
  );
}

type Draft = { id: string | null; label: string; tooltip: string; icon: BadgeIcon; tone: BadgeTone; filter: Segment; active: boolean };
const blank = (): Draft => ({ id: null, label: "", tooltip: "", icon: "tag", tone: "blue", filter: EMPTY_SEGMENT, active: true });

export function CustomBadgesEditor({ list, options, sees }: { list: CustomBadge[]; options: FilterOptions; sees: PanelSees }) {
  const { pending, error, run } = useAction();
  const [draft, setDraft] = useState<Draft | null>(null);
  const problem = draft ? customBadgeProblem(draft.filter) : null;
  return (
    <Card>
      <CardHeader
        title="Custom badges"
        subtitle="Build a badge from any client filter, e.g. 'Beard regular' for clients who bought beard oil. Clients get it when they match, as of the nightly run or their last checkout."
        action={
          !draft && (
            <Button size="sm" onClick={() => setDraft(blank())} data-testid="new-custom-badge">
              New badge
            </Button>
          )
        }
      />
      <div className="space-y-3 px-4 py-3">
        {!list.length && !draft && <p className="text-sm text-zinc-500">No custom badges yet.</p>}
        {list.map((c) => (
          <div key={c.id} className={cx("flex items-center justify-between gap-3 rounded-lg px-3 py-2 ring-1 ring-zinc-200", !c.active && "opacity-60")}>
            <div className="flex min-w-0 items-center gap-2">
              <ClientBadge badge={{ key: customKey(c.id), label: c.label, icon: c.icon, tone: c.tone, tip: c.tooltip || c.label }} />
              <span className="truncate text-xs text-zinc-500">{c.tooltip}</span>
              {!c.active && <Badge>Off</Badge>}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDraft({ ...c })}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm(`Remove the "${c.label}" badge?`) && run(() => deleteCustomBadgeAction(c.id))}>
                Remove
              </Button>
            </div>
          </div>
        ))}
        {draft && (
          <div className="space-y-3 rounded-lg p-3 ring-1 ring-brand-200" data-testid="custom-badge-form">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Name" className="sm:col-span-2">
                <Input maxLength={24} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </Field>
              <Field label="Icon">
                <Select value={draft.icon} onChange={(e) => setDraft({ ...draft, icon: e.target.value as BadgeIcon })}>
                  {BADGE_ICONS.map((i) => (
                    <option key={i} value={i}>
                      {i.replace("_", " ")}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Colour">
                <Select value={draft.tone} onChange={(e) => setDraft({ ...draft, tone: e.target.value as BadgeTone })}>
                  {BADGE_TONES.map((t) => (
                    <option key={t} value={t}>
                      {BADGE_TONE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Tooltip" hint="Why a client has it, shown on hover.">
              <Textarea rows={2} maxLength={200} value={draft.tooltip} onChange={(e) => setDraft({ ...draft, tooltip: e.target.value })} />
            </Field>
            <div className="flex items-center gap-3 text-sm">
              <span className="text-xs text-zinc-500">Preview</span>
              <ClientBadge badge={{ key: "preview", label: draft.label || "Badge", icon: draft.icon, tone: draft.tone, tip: draft.tooltip || draft.label }} />
              <label className="ml-auto flex items-center gap-2 text-zinc-700">
                <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
                On
              </label>
            </div>
            <SegmentFilters seg={draft.filter} options={options} sees={sees} noBadges onChange={(x) => setDraft({ ...draft, filter: { ...draft.filter, ...x } })} />
            {problem && <p className="text-xs text-zinc-500">{problem}</p>}
            {error && <p className="text-sm text-red-700">{error}</p>}
            <div className="flex gap-2">
              <Button disabled={pending || !!problem || !draft.label.trim()} onClick={() => run(() => saveCustomBadgeAction(draft), () => setDraft(null))}>
                Save badge
              </Button>
              <Button variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
