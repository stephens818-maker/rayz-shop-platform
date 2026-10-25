"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { TimeInput } from "@/components/time-input";
import { Badge, Button, Card, CardHeader, Input, Select, cx } from "@/components/ui";
import {
  BOOKING_OPTION_KEYS,
  BOOKING_OPTION_META,
  BookingOptionKey,
  OPTION_SOURCE_LABEL,
  StaffBookingOptions,
  isBoolKey,
  minutesLabel,
} from "@/domain/staff-booking";
import {
  FIRST_REMINDER_HOURS,
  SECOND_REMINDER_HOURS,
  STAFF_CHANNELS,
  STAFF_CHANNEL_LABEL,
  STAFF_EVENTS,
  STAFF_EVENT_LABEL,
  StaffChannel,
  StaffNotificationPrefs,
} from "@/domain/staff-notifications";
import { formatTimeOfDay } from "@/lib/time-parse";
import type { BookingOptionsView, DayHistoryRow } from "@/server/staff-settings";
import { addDayOnAction, removeDayOnAction, saveBookingOptionsAction, saveNotificationPrefsAction, setVisibleOnlineAction } from "../settings-actions";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<Result<T>>, msg: string, after?: (d: T) => void) =>
    start(async () => {
      setError(null);
      setOk(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      setOk(msg);
      after?.(r.data);
      router.refresh();
    });
  return { pending, error, ok, run };
}

function Status({ error, ok }: { error: string | null; ok: string | null }) {
  if (error) return <span className="text-sm text-red-600">{error}</span>;
  if (ok) return <span className="text-sm text-emerald-700">{ok}</span>;
  return null;
}

const showValue = (k: BookingOptionKey, v: boolean | number) => {
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (BOOKING_OPTION_META[k].kind === "days") return `${v} day${v === 1 ? "" : "s"}`;
  return minutesLabel(v);
};

/**
 * One person, several shops: settings for all shops, or for one shop only. Each value says where it
 * comes from, so "this shop only" never hides that the other shops differ.
 */
export function BookingOptionsCard({ staffId, view, canEdit }: { staffId: string; view: BookingOptionsView; canEdit: boolean }) {
  const { pending, error, ok, run } = useRun();
  const scopes = [...(view.canSetAll ? [{ id: "all", label: "All shops" }] : []), ...view.shops.map((s) => ({ id: s.shopId, label: `${s.shopName} only` }))];
  const [scope, setScope] = useState(scopes[0]?.id ?? "all");
  const saved = scope === "all" ? view.all : (view.shops.find((s) => s.shopId === scope)?.here ?? {});
  const [draft, setDraft] = useState<Record<string, string>>(() => toDraft(saved));
  const pick = (id: string) => {
    setScope(id);
    setDraft(toDraft(id === "all" ? view.all : (view.shops.find((s) => s.shopId === id)?.here ?? {})));
  };
  const inherited = (k: BookingOptionKey) => {
    if (scope === "all") return "the shop's setting";
    const s = view.shops.find((x) => x.shopId === scope)!;
    const fromAll = view.all[k];
    return fromAll !== undefined ? `all shops: ${showValue(k, fromAll)}` : `shop default: ${showValue(k, s.effective[k].value)}`;
  };
  const save = () => {
    const options: Record<string, unknown> = {};
    for (const k of BOOKING_OPTION_KEYS) {
      const v = draft[k];
      if (v === undefined || v === "") continue;
      options[k] = isBoolKey(k) ? v === "on" : Number(v);
    }
    run(() => saveBookingOptionsAction({ staffId, scope, options }), scope === "all" ? "Saved for all shops" : "Saved for this shop only");
  };

  if (!view.shops.length) {
    return (
      <Card>
        <CardHeader title="Booking options" />
        <div className="p-4 text-sm text-zinc-500">Add a shop in the profile first.</div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Booking options" subtitle="For clients booking themselves. Staff booking from the calendar isn't held to these. Blank follows the next level up." />
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1 text-xs font-medium text-zinc-500">Visible online</div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {view.shops.map((s) => (
              <label key={s.shopId} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  disabled={!canEdit || pending}
                  checked={s.visibleOnline}
                  onChange={(e) => run(() => setVisibleOnlineAction({ staffId, scope: s.shopId, visible: e.target.checked }), `${e.target.checked ? "Shown" : "Hidden"} at ${s.shopName} only`)}
                />
                {s.shopName} <span className="text-xs text-zinc-400">this shop only</span>
              </label>
            ))}
            {view.canSetAll && view.shops.length > 1 && (
              <span className="flex gap-1">
                <Button size="sm" variant="secondary" disabled={!canEdit || pending} onClick={() => run(() => setVisibleOnlineAction({ staffId, scope: "all", visible: true }), "Shown at all shops")}>
                  Show at all shops
                </Button>
                <Button size="sm" variant="secondary" disabled={!canEdit || pending} onClick={() => run(() => setVisibleOnlineAction({ staffId, scope: "all", visible: false }), "Hidden at all shops")}>
                  Hide at all shops
                </Button>
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">Hidden barbers aren&apos;t on the booking site or in the app at that shop; staff can still book them.</p>
        </div>

        <div role="tablist" aria-label="Which shops" className="flex flex-wrap gap-1">
          {scopes.map((s) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={s.id === scope}
              onClick={() => pick(s.id)}
              className={cx("rounded-full px-3 py-1 text-sm ring-1", s.id === scope ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-zinc-500">
          {scope === "all" ? "Editing their settings at every shop they work at. A shop's own setting below still wins at that shop." : "Editing this shop only. Other shops keep their own or the all-shops setting."}
        </p>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500">
                <th className="py-2 pr-3 font-semibold">Option</th>
                <th className="py-2 pr-3 font-semibold">{scope === "all" ? "All shops" : "This shop only"}</th>
                {view.shops.map((s) => (
                  <th key={s.shopId} className="py-2 pr-3 font-semibold">
                    In effect at {s.shopName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {BOOKING_OPTION_KEYS.map((k) => {
                const meta = BOOKING_OPTION_META[k];
                return (
                  <tr key={k} className="border-b border-zinc-100 align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{meta.label}</div>
                      <div className="max-w-xs text-xs text-zinc-500">{meta.hint}</div>
                    </td>
                    <td className="py-2 pr-3">
                      {isBoolKey(k) ? (
                        <Select aria-label={meta.label} disabled={!canEdit} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} className="h-8 text-sm">
                          <option value="">Follow {inherited(k)}</option>
                          <option value="on">On</option>
                          <option value="off">Off</option>
                        </Select>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Input
                            aria-label={meta.label}
                            disabled={!canEdit}
                            inputMode="numeric"
                            className="h-8 w-24 text-sm"
                            placeholder="Follow"
                            value={draft[k] ?? ""}
                            onChange={(e) => setDraft({ ...draft, [k]: e.target.value.replace(/[^0-9]/g, "") })}
                          />
                          <span className="text-xs text-zinc-500">{meta.kind === "days" ? "days" : "min"}</span>
                          {!draft[k] && <span className="text-xs text-zinc-400">({inherited(k)})</span>}
                        </div>
                      )}
                    </td>
                    {view.shops.map((s) => (
                      <td key={s.shopId} className="py-2 pr-3">
                        <div>{showValue(k, s.effective[k].value)}</div>
                        <Badge tone={s.effective[k].source === "this_shop" ? "amber" : s.effective[k].source === "all_shops" ? "blue" : "gray"}>{OPTION_SOURCE_LABEL[s.effective[k].source]}</Badge>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button disabled={pending} onClick={save}>
              Save {scope === "all" ? "for all shops" : "for this shop only"}
            </Button>
            <Status error={error} ok={ok} />
          </div>
        )}
      </div>
    </Card>
  );
}

function toDraft(o: StaffBookingOptions): Record<string, string> {
  const d: Record<string, string> = {};
  for (const k of BOOKING_OPTION_KEYS) {
    const v = o[k];
    if (v === undefined) continue;
    d[k] = typeof v === "boolean" ? (v ? "on" : "off") : String(v);
  }
  return d;
}

export function NotificationsCard({ staffId, prefs, canEdit, self }: { staffId: string; prefs: StaffNotificationPrefs; canEdit: boolean; self: boolean }) {
  const { pending, error, ok, run } = useRun();
  const [p, setP] = useState(prefs);
  const has = (e: (typeof STAFF_EVENTS)[number], c: StaffChannel) => (p.events[e] ?? []).includes(c);
  const flip = (e: (typeof STAFF_EVENTS)[number], c: StaffChannel) => {
    const cur = p.events[e] ?? [];
    setP({ ...p, events: { ...p.events, [e]: cur.includes(c) ? cur.filter((x) => x !== c) : [...cur, c] } });
  };
  return (
    <Card>
      <CardHeader
        title="Notifications"
        subtitle={`How ${self ? "you hear" : "they hear"} about ${self ? "your" : "their"} clients' bookings, and when ${self ? "your" : "their"} clients are reminded. Alerts use first names only.`}
      />
      <div className="space-y-4 p-4">
        <table className="text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-500">
              <th className="pr-6 pb-1 font-semibold">When</th>
              {STAFF_CHANNELS.map((c) => (
                <th key={c} className="pr-4 pb-1 font-semibold">
                  {STAFF_CHANNEL_LABEL[c]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {STAFF_EVENTS.map((e) => (
              <tr key={e}>
                <td className="py-1 pr-6">{STAFF_EVENT_LABEL[e]}</td>
                {STAFF_CHANNELS.map((c) => (
                  <td key={c} className="py-1 pr-4">
                    <input type="checkbox" aria-label={`${STAFF_EVENT_LABEL[e]} by ${STAFF_CHANNEL_LABEL[c]}`} disabled={!canEdit} checked={has(e, c)} onChange={() => flip(e, c)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-zinc-500">App alerts start when the staff app sends push; texts and emails go to the phone and email on the profile.</p>
        <div className="flex flex-wrap gap-4 text-sm">
          <label>
            <span className="block text-xs text-zinc-500">First client reminder</span>
            <Select disabled={!canEdit} value={String(p.firstHours ?? "")} onChange={(e) => setP({ ...p, firstHours: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-9">
              <option value="">Shop default (24 hours before)</option>
              {FIRST_REMINDER_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h ? `${h} hours before` : "No first reminder"}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="block text-xs text-zinc-500">Second client reminder</span>
            <Select disabled={!canEdit} value={String(p.secondHours ?? "")} onChange={(e) => setP({ ...p, secondHours: e.target.value === "" ? undefined : Number(e.target.value) })} className="h-9">
              <option value="">Shop default (2 hours before)</option>
              {SECOND_REMINDER_HOURS.map((h) => (
                <option key={h} value={h}>
                  {h ? `${h} hour${h === 1 ? "" : "s"} before` : "No second reminder"}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {canEdit && (
          <div className="flex items-center gap-3">
            <Button disabled={pending} onClick={() => run(() => saveNotificationPrefsAction({ staffId, prefs: p }), "Notifications saved")}>
              Save notifications
            </Button>
            <Status error={error} ok={ok} />
          </div>
        )}
      </div>
    </Card>
  );
}

export function DaysOnCard({
  staffId,
  shops,
  history,
  canEdit,
}: {
  staffId: string;
  shops: { id: string; name: string }[];
  history: (DayHistoryRow & { shopName: string })[];
  canEdit: boolean;
}) {
  const { pending, error, ok, run } = useRun();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [start, setStart] = useState(9 * 60);
  const [end, setEnd] = useState(17 * 60);
  const [note, setNote] = useState("");
  return (
    <Card>
      <CardHeader title="Days off and on" subtitle="A day on adds hours outside the weekly schedule, even on a day the shop is usually closed. Days off are the time off above. Last 90 days and what's coming." />
      <div className="space-y-4 p-4">
        {canEdit && shops.length > 0 && (
          <div className="flex flex-wrap items-end gap-2 text-sm">
            <label>
              <span className="block text-xs text-zinc-500">Shop</span>
              <Select value={shopId} onChange={(e) => setShopId(e.target.value)} className="h-9">
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              <span className="block text-xs text-zinc-500">Date</span>
              <Input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} className="h-9" />
            </label>
            <label>
              <span className="block text-xs text-zinc-500">From</span>
              <TimeInput aria-label="Day on start" value={start} onChange={setStart} className="h-9 text-sm" />
            </label>
            <label>
              <span className="block text-xs text-zinc-500">To</span>
              <TimeInput aria-label="Day on end" value={end} onChange={setEnd} className="h-9 text-sm" />
            </label>
            <label className="min-w-48 flex-1">
              <span className="block text-xs text-zinc-500">Note (optional)</span>
              <Input value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} className="h-9" placeholder="Covering Saturday, Sunday event…" />
            </label>
            <Button disabled={pending || !shopId} onClick={() => run(() => addDayOnAction({ staffId, shopId, date, startMin: start, endMin: end, note: note || null }), "Day on added", () => setNote(""))}>
              Add day on
            </Button>
          </div>
        )}
        <Status error={error} ok={ok} />
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500">No days off or on in the last 90 days or coming up.</p>
        ) : (
          <ul className="divide-y divide-zinc-100 text-sm">
            {history.map((h) => (
              <li key={`${h.kind}:${h.id}`} className={cx("flex items-center gap-3 py-2", h.removed && "text-zinc-400 line-through")}>
                <Badge tone={h.kind === "on" ? "green" : "amber"}>{h.kind === "on" ? "Day on" : "Day off"}</Badge>
                <span className="tabular-nums">
                  {h.date}
                  {h.through ? ` → ${h.through}` : ""}
                </span>
                {h.startMin !== null && h.endMin !== null && (
                  <span>
                    {formatTimeOfDay(h.startMin)}–{formatTimeOfDay(h.endMin)}
                  </span>
                )}
                <span className="text-zinc-500">{h.shopName}</span>
                {h.note && <span className="text-zinc-500">· {h.note}</span>}
                {h.removed && <span className="text-xs no-underline">removed</span>}
                {!h.upcoming && !h.removed && <span className="text-xs text-zinc-400">past</span>}
                {canEdit && h.kind === "on" && h.upcoming && !h.removed && (
                  <button className="ml-auto text-xs text-red-700 hover:underline" disabled={pending} onClick={() => run(() => removeDayOnAction({ id: h.id, staffId }), "Day on removed")}>
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
