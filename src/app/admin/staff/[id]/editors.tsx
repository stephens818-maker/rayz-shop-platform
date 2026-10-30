"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ConflictConfirm } from "@/components/conflict-confirm";
import { ClockInput, TimeInput } from "@/components/time-input";
import { type PickReason, ReasonPicker, ReasonTag } from "@/components/reason-picker";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, cx } from "@/components/ui";
import type { ShownReason } from "@/domain/block-reasons";
import type { BookedConflict } from "@/server/staff-time";
import { addTimeOffAction, deleteTimeOffAction, offboardStaffAction, saveProfileAction, saveScheduleAction } from "../actions";
import { compactTimeOfDay } from "@/lib/time-parse";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mins = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
};
const label = (m: number) => compactTimeOfDay(m);

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>, msg: string | ((d: T) => string | null), after?: (d: T) => void) =>
    start(async () => {
      setError(null);
      setOk(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      setOk(typeof msg === "function" ? msg(r.data) : msg);
      after?.(r.data);
      router.refresh();
    });
  return { pending, error, ok, run, router };
}

type Profile = {
  id: string;
  firstName: string;
  lastName: string;
  displayLabel: string;
  email: string;
  phone: string;
  color: string;
  roleId: string | null;
  isBookable: boolean;
  active: boolean;
  squireName: string;
  hireDate: string;
  shopIds: string[];
  hasLogin: boolean;
};

type RoleChoice = { id: string; name: string; description: string; defaultScope: string };
const SCOPE_HINT: Record<string, string> = { all: "every shop", entity: "every shop of the owner of the shops they work at", selected: "the shops they work at", one: "one shop" };

export function ProfileForm({
  initial,
  shops,
  allShops,
  roles,
  readOnly,
  contactMasked = false,
  defaultRoleId = null,
}: {
  initial: Profile | null;
  shops: { id: string; name: string }[];
  allShops: { id: string; name: string }[];
  roles: RoleChoice[];
  /** The location's starting role for new staff (Brand defaults). */
  defaultRoleId?: string | null;
  readOnly: boolean;
  contactMasked?: boolean;
}) {
  const { pending, error, ok, run, router } = useRun();
  const [p, setP] = useState<Profile>(
    initial ?? {
      id: "",
      firstName: "",
      lastName: "",
      displayLabel: "",
      email: "",
      phone: "",
      color: "#2563eb",
      roleId: defaultRoleId ?? roles.find((r) => r.name === "Barber")?.id ?? roles[0]?.id ?? null,
      isBookable: true,
      active: true,
      squireName: "",
      hireDate: "",
      shopIds: shops.length === 1 ? [shops[0].id] : [],
      hasLogin: false,
    },
  );
  const [password, setPassword] = useState("");
  const set = (patch: Partial<Profile>) => setP({ ...p, ...patch });
  const lockedShops = p.shopIds.filter((s) => !shops.some((x) => x.id === s));
  return (
    <Card>
      <CardHeader title="Profile" subtitle="The display label is what customers and the calendar show. Use an initial when first names collide (Taylor A. / Taylor B.)." />
      <fieldset disabled={readOnly} className="grid gap-4 p-4 disabled:opacity-80 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="First name">
          <Input
            value={p.firstName}
            onChange={(e) => set({ firstName: e.target.value, displayLabel: !p.displayLabel || p.displayLabel === p.firstName ? e.target.value : p.displayLabel })}
          />
        </Field>
        <Field label="Last name (private)" hint="Never shown to customers or used in links.">
          <Input value={p.lastName} onChange={(e) => set({ lastName: e.target.value })} />
        </Field>
        <Field label="Display label">
          <div className="flex gap-2">
            <Input value={p.displayLabel} onChange={(e) => set({ displayLabel: e.target.value })} />
            {p.lastName && (
              <Button variant="secondary" type="button" onClick={() => set({ displayLabel: `${p.firstName} ${p.lastName[0].toUpperCase()}.` })}>
                + initial
              </Button>
            )}
          </div>
        </Field>
        <Field label="Email (login)" hint={contactMasked ? "Masked. You need “See staff phone numbers and email addresses” to see or change it." : undefined}>
          <Input type={contactMasked ? "text" : "email"} value={p.email} disabled={contactMasked} onChange={(e) => set({ email: e.target.value })} />
        </Field>
        <Field label="Phone" hint={contactMasked ? "Masked." : undefined}>
          <Input value={p.phone} disabled={contactMasked} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="Calendar color">
          <Input type="color" className="h-[38px] p-1" value={p.color} onChange={(e) => set({ color: e.target.value })} />
        </Field>
        {!p.id && (
          <Field
            label="Role"
            hint={(() => {
              const r = roles.find((x) => x.id === p.roleId);
              return r ? `Access to ${SCOPE_HINT[r.defaultScope] ?? "selected shops"}. Fine-tune later under Permissions.` : "You can only give roles with permissions you have.";
            })()}
          >
            <Select value={p.roleId ?? ""} onChange={(e) => set({ roleId: e.target.value || null })}>
              {roles.map((r) => (
                <option key={r.id} value={r.id} title={r.description}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label={p.hasLogin ? "Reset password" : "Set password (enables login)"}>
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label="Squire name" hint="Exact name in Squire exports, used to match imported appointments.">
          <Input value={p.squireName} onChange={(e) => set({ squireName: e.target.value })} />
        </Field>
        <Field label="Hire date" hint="For work anniversaries. From Squire or their start paperwork.">
          <Input type="date" min="1950-01-01" value={p.hireDate} onChange={(e) => set({ hireDate: e.target.value })} />
        </Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <div className="mb-1 text-xs font-medium text-zinc-700">Works at</div>
          <div className="flex flex-wrap gap-1.5">
            {shops.map((s) => {
              const on = p.shopIds.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => set({ shopIds: on ? p.shopIds.filter((x) => x !== s.id) : [...p.shopIds, s.id] })}
                  className={cx("rounded-full px-3 py-1 text-sm ring-1", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
                >
                  {s.name}
                </button>
              );
            })}
            {lockedShops.map((id) => (
              <Badge key={id}>{allShops.find((s) => s.id === id)?.name}</Badge>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-5 text-sm sm:col-span-2 lg:col-span-3">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={p.isBookable} onChange={(e) => set({ isBookable: e.target.checked })} /> Takes appointments
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={p.active} onChange={(e) => set({ active: e.target.checked })} /> Active
          </label>
        </div>
      </fieldset>
      <div className={cx("flex items-center gap-3 border-t border-zinc-100 px-4 py-3", readOnly && "hidden")}>
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => saveProfileAction({ ...p, ...(contactMasked ? { email: "", phone: "" } : {}), id: p.id || null, password }),
              "Saved",
              (d) => {
                setPassword("");
                if (!p.id) router.push(`/admin/staff/${d.id}`);
              },
            )
          }
        >
          {p.id ? "Save profile" : "Create"}
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
        {ok && <span className="text-sm text-emerald-700">{ok}</span>}
      </div>
    </Card>
  );
}

type Row = { shopId: string; weekday: number; startMin: number; endMin: number };

export function ScheduleEditor({
  staffId,
  shops,
  schedules,
  hours,
}: {
  staffId: string;
  shops: { id: string; name: string; editable: boolean }[];
  schedules: Row[];
  hours: { shopId: string; weekday: number; openMin: number; closeMin: number }[];
}) {
  const { pending, error, ok, run } = useRun();
  const [rows, setRows] = useState<Row[]>(schedules);
  const get = (shopId: string, wd: number) => rows.find((r) => r.shopId === shopId && r.weekday === wd);
  const toggle = (shopId: string, wd: number) => {
    const ex = get(shopId, wd);
    if (ex) return setRows(rows.filter((r) => r !== ex));
    const h = hours.find((x) => x.shopId === shopId && x.weekday === wd);
    setRows([...rows, { shopId, weekday: wd, startMin: h?.openMin ?? 9 * 60, endMin: h?.closeMin ?? 17 * 60 }]);
  };
  const update = (r: Row, patch: Partial<Row>) => setRows(rows.map((x) => (x === r ? { ...r, ...patch } : x)));
  const overlaps = (r: Row) => rows.some((o) => o !== r && o.weekday === r.weekday && o.startMin < r.endMin && r.startMin < o.endMin);

  if (shops.length === 0) {
    return (
      <Card>
        <CardHeader title="Weekly hours" />
        <div className="p-4 text-sm text-zinc-500">Add at least one shop in the profile, then set hours here.</div>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader title="Weekly hours" subtitle="Per shop. Overlapping hours at two shops on the same day are rejected, so a barber can't be double-booked across shops." />
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-zinc-50 text-xs text-zinc-500">
              <th className="px-3 py-2 text-left font-semibold">Shop</th>
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <th key={d} className="px-2 py-2 text-left font-semibold">
                  {DAYS[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shops.map((s) => (
              <tr key={s.id} className="border-b border-zinc-100 align-top">
                <td className="px-3 py-2 font-medium">
                  {s.name}
                  {!s.editable && <div className="text-xs font-normal text-zinc-400">read-only</div>}
                </td>
                {[1, 2, 3, 4, 5, 6, 0].map((d) => {
                  const r = get(s.id, d);
                  const h = hours.find((x) => x.shopId === s.id && x.weekday === d);
                  if (!h && !r) return <td key={d} className="px-2 py-2 text-xs text-zinc-400">Closed</td>;
                  return (
                    <td key={d} className={cx("px-2 py-2", r && overlaps(r) && "bg-red-50")}>
                      <label className="flex items-center gap-1 text-xs">
                        <input type="checkbox" disabled={!s.editable} checked={!!r} onChange={() => toggle(s.id, d)} />
                        {r ? "Working" : <span className="text-zinc-400">Off</span>}
                      </label>
                      {r && (
                        <div className="mt-1 space-y-1">
                          <TimeInput aria-label={`${s.name} ${DAYS[d]} start`} disabled={!s.editable} value={r.startMin} onChange={(m) => update(r, { startMin: m })} />
                          <TimeInput aria-label={`${s.name} ${DAYS[d]} end`} disabled={!s.editable} value={r.endMin} onChange={(m) => update(r, { endMin: m })} />
                        </div>
                      )}
                      {h && <div className="mt-1 text-[10px] text-zinc-400">shop {label(h.openMin)}–{label(h.closeMin)}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <Button disabled={pending} onClick={() => run(() => saveScheduleAction(staffId, rows.filter((r) => shops.find((s) => s.id === r.shopId)?.editable)), "Hours saved")}>
          Save hours
        </Button>
        {error && <span className="text-sm text-red-600">{error}</span>}
        {ok && <span className="text-sm text-emerald-700">{ok}</span>}
      </div>
    </Card>
  );
}

export function TimeOff({
  staffId,
  shops,
  blocks,
  reasons,
}: {
  staffId: string;
  shops: { id: string; name: string }[];
  blocks: { id: string; label: string; reason: ShownReason; kind: string; shop: string }[];
  reasons: PickReason[];
}) {
  const { pending, error, run } = useRun();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("12:00");
  const [end, setEnd] = useState("13:00");
  const [reasonId, setReasonId] = useState<string | null>(reasons[0]?.id ?? null);
  const [note, setNote] = useState("");
  const [shopId, setShopId] = useState<string>("");
  const [conflicts, setConflicts] = useState<BookedConflict[] | null>(null);
  const add = (confirm: boolean) =>
    run(
      () => addTimeOffAction({ staffId, shopId: shopId || null, from, to, allDay, startMin: mins(start), endMin: mins(end), reasonId: reasonId ?? "", note: note || null, confirm }),
      (d) => (d.saved ? "Added" : null),
      (d) => {
        if (d.saved) {
          setNote("");
          setConflicts(null);
        } else setConflicts(d.conflicts);
      },
    );
  return (
    <Card>
      <CardHeader title="Days off & time off" subtitle="Time off removes availability online and shows on the calendar with its reason. Requests barbers send come in on Time off." />
      <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="From">
          <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), e.target.value > to && setTo(e.target.value))} />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Field label="Time">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> All day
            </label>
            {!allDay && (
              <>
                <ClockInput aria-label="From" className="h-7 w-[92px] text-xs" value={start} onChange={setStart} />
                <ClockInput aria-label="To" className="h-7 w-[92px] text-xs" value={end} onChange={setEnd} />
              </>
            )}
          </div>
        </Field>
        <Field label="Applies to">
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)}>
            <option value="">All shops</option>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} only
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2 lg:col-span-3">
          <ReasonPicker reasons={reasons} value={reasonId} onChange={setReasonId} note={note} onNote={setNote} notePlaceholder="e.g. Family trip" timeOff />
        </div>
        <div className="flex items-end">
          <Button className="w-full" disabled={pending || !!conflicts || !reasonId} onClick={() => add(false)}>
            Add
          </Button>
        </div>
      </div>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
      {conflicts && (
        <div className="px-4 pb-3">
          <ConflictConfirm
            conflicts={conflicts}
            pending={pending}
            confirmLabel="Add time off anyway"
            note="They stay booked. Move them to another barber or ask the clients to reschedule from Time off."
            onConfirm={() => add(true)}
            onCancel={() => setConflicts(null)}
          />
        </div>
      )}
      <ul className="divide-y divide-zinc-100 border-t border-zinc-100">
        {blocks.length === 0 && <li className="px-4 py-3 text-sm text-zinc-500">Nothing upcoming.</li>}
        {blocks.map((b) => (
          <li key={b.id} className="flex flex-wrap items-center gap-3 px-4 py-2 text-sm">
            <Badge tone={b.kind === "day_off" ? "violet" : "amber"}>{b.kind === "day_off" ? "Day off" : "Block"}</Badge>
            <ReasonTag reason={b.reason} />
            {b.reason.note && <span className="text-zinc-600">{b.reason.note}</span>}
            <span className="text-zinc-500">{b.label}</span>
            <span className="text-xs text-zinc-400">{b.shop}</span>
            <button className="ml-auto text-xs text-red-600 underline" disabled={pending} onClick={() => run(() => deleteTimeOffAction(b.id), "Removed")}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Leaving the team, in one step. Their history stays; booked appointments are listed to move. */
export function OffboardCard({ staffId, label }: { staffId: string; label: string }) {
  const { pending, error, ok, run } = useRun();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  return (
    <Card>
      <CardHeader title="Offboard" subtitle="When someone leaves. Sign-in stops at once; sales, tips, punches and payroll history stay." />
      <div className="space-y-3 p-4 text-sm">
        {!open ? (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Offboard {label}…
          </Button>
        ) : (
          <>
            <ul className="list-disc space-y-1 pl-5 text-zinc-600">
              <li>Signs them out everywhere and turns off their login</li>
              <li>Takes them off online booking and every shop&apos;s schedule</li>
              <li>Ends their recurring blocks and cancels pending time-off requests</li>
              <li>Leaves booked appointments booked, listed below to move or reschedule</li>
            </ul>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Reason (private, in the audit log)">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional" />
              </Field>
              <Field label={`Type "${label}" to confirm`}>
                <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </Field>
            </div>
            <div className="flex gap-2">
              <Button
                variant="danger"
                disabled={pending || confirm.trim().toLowerCase() !== label.toLowerCase()}
                onClick={() =>
                  run(
                    () => offboardStaffAction(staffId, confirm, reason),
                    (d) =>
                      `Done. Removed ${d.schedules} schedule row${d.schedules === 1 ? "" : "s"}, ended ${d.recurringBlocks} recurring block${d.recurringBlocks === 1 ? "" : "s"}, cancelled ${d.timeOffRequests} time-off request${d.timeOffRequests === 1 ? "" : "s"}.${d.bookings ? ` ${d.bookings} booked appointment${d.bookings === 1 ? "" : "s"} still need${d.bookings === 1 ? "s" : ""} a new barber.` : ""}`,
                  )
                }
              >
                Offboard now
              </Button>
              <Button variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </>
        )}
        {error && <Notice tone="red">{error}</Notice>}
        {ok && <Notice tone="green">{ok}</Notice>}
      </div>
    </Card>
  );
}
