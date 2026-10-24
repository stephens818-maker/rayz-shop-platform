"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { ReasonTag } from "@/components/reason-picker";
import type { StaffTimeRules } from "@/domain/staff-time";
import type { AffectedAppointment, RequestView } from "@/server/staff-time";
import { askRescheduleAction, cancelTimeOffAction, decideTimeOffAction, reassignAction, reassignOptionsAction, saveRulesAction } from "./actions";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = <T,>(fn: () => Promise<Result<T>>, after?: (d: T) => string | null | void) =>
    start(async () => {
      setError(null);
      setOk(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      const msg = after?.(r.data);
      if (msg) setOk(msg);
      router.refresh();
    });
  return { pending, error, ok, run };
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AffectedRow({ a }: { a: AffectedAppointment }) {
  const { pending, error, ok, run } = useRun();
  const [options, setOptions] = useState<{ staffId: string; label: string; free: boolean }[] | null>(null);
  const [to, setTo] = useState("");
  const load = () =>
    run(
      () => reassignOptionsAction(a.id),
      (d) => {
        setOptions(d);
        setTo(d.find((o) => o.free)?.staffId ?? "");
        return d.length ? null : "No other barbers at this shop for this service.";
      },
    );
  return (
    <li className="space-y-2 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{when(a.startsAt)}</span>
        <span>{a.customerName}</span>
        <span className="text-zinc-500">
          {a.shopName} · {a.code}
        </span>
        {a.askedAt && <Badge tone="blue">asked to reschedule {when(a.askedAt)}</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {options === null ? (
          <Button size="sm" variant="secondary" disabled={pending} onClick={load}>
            Move to another barber…
          </Button>
        ) : (
          options.length > 0 && (
            <>
              <Select aria-label="Move to" className="h-8 w-auto py-0 text-sm" value={to} onChange={(e) => setTo(e.target.value)}>
                <option value="">Pick a barber</option>
                {options.map((o) => (
                  <option key={o.staffId} value={o.staffId}>
                    {o.label}
                    {o.free ? " (free)" : " (busy then)"}
                  </option>
                ))}
              </Select>
              <Button size="sm" disabled={pending || !to} onClick={() => run(() => reassignAction(a.id, to), () => "Moved. The client was told who they're with now.")}>
                Move, same time
              </Button>
            </>
          )
        )}
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(
              () => askRescheduleAction(a.id),
              (d) => (d.sent ? `Asked the client to pick a new time (${d.sent} message${d.sent === 1 ? "" : "s"}). The booking stays until they do.` : "This client has no texts or emails turned on. Call them through the shop line."),
            )
          }
        >
          {a.askedAt ? "Ask again" : "Ask client to reschedule"}
        </Button>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
      {ok && <Notice tone="green">{ok}</Notice>}
    </li>
  );
}

export function RequestCard({ request: r, affected, canDecide, why }: { request: RequestView; affected: AffectedAppointment[]; canDecide: boolean; why: string | null }) {
  const { pending, error, ok, run } = useRun();
  const [note, setNote] = useState("");
  const isPending = r.status === "pending";
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {r.staffLabel}
            <span className="font-normal text-zinc-600">{r.range}</span>
            <Badge tone={isPending ? "amber" : "green"}>{isPending ? "waiting" : r.decidedVia === "auto" ? "approved (auto)" : "approved"}</Badge>
            <ReasonTag reason={r.reason} />
          </span>
        }
        subtitle={`${r.shopName ?? "All their shops"}${r.reason.note ? ` · "${r.reason.note}"` : ""}`}
      />
      {affected.length > 0 && (
        <div className="border-t border-amber-100 bg-amber-50/50">
          <div className="px-4 pt-3 text-sm font-medium text-amber-900">
            {affected.length} booked appointment{affected.length === 1 ? "" : "s"} in this time. {isPending ? "They stay booked whatever you decide." : "Still booked with this barber:"}
          </div>
          <ul className="divide-y divide-amber-100">
            {affected.map((a) => (
              <AffectedRow key={a.id} a={a} />
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-3 border-t border-zinc-100 p-4">
        {canDecide && isPending && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Note to the barber (optional)" className="min-w-56 flex-1">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
            <Button disabled={pending} onClick={() => run(() => decideTimeOffAction(r.id, "approve", note), (d) => (d.affected ? `Approved. Move or reschedule the ${d.affected} booked appointment(s) above.` : "Approved."))}>
              Approve
            </Button>
            <Button variant="danger" disabled={pending} onClick={() => run(() => decideTimeOffAction(r.id, "deny", note), () => "Denied. The barber was told.")}>
              Deny
            </Button>
          </div>
        )}
        {canDecide && !isPending && (
          <Button size="sm" variant="danger" disabled={pending} onClick={() => confirm(`Cancel ${r.staffLabel}'s approved time off? It goes back on the books.`) && run(() => cancelTimeOffAction(r.id), () => "Cancelled.")}>
            Cancel this time off
          </Button>
        )}
        {!canDecide && why && <p className="text-sm text-zinc-500">{why}</p>}
        {error && <Notice tone="red">{error}</Notice>}
        {ok && <Notice tone="green">{ok}</Notice>}
      </div>
    </Card>
  );
}

type RulesRow = { key: string; shopId: string | null; name: string; overrides: Partial<StaffTimeRules>; effective: StaffTimeRules };

function RuleRow({ row, inherit }: { row: RulesRow; inherit: StaffTimeRules | null }) {
  const { pending, error, ok, run } = useRun();
  const o = row.overrides;
  const [approval, setApproval] = useState<string>(o.timeOffApproval ?? "");
  const [lunch, setLunch] = useState(o.maxLunchMin?.toString() ?? "");
  const [block, setBlock] = useState(o.maxBlockMin?.toString() ?? "");
  const [notice, setNotice] = useState(o.minNoticeDays?.toString() ?? "");
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  const ph = (v: number | undefined) => (inherit ? `${v}` : "");
  return (
    <tr className="align-top">
      <td className="px-4 py-2 font-medium">{row.name}</td>
      <td className="px-2 py-2">
        <Select aria-label={`${row.name}: approval`} value={approval} onChange={(e) => setApproval(e.target.value)}>
          {inherit && <option value="">Brand ({inherit.timeOffApproval === "auto" ? "automatic" : "manager"})</option>}
          {!inherit && <option value="">Default (manager)</option>}
          <option value="manager">Manager approves</option>
          <option value="auto">Automatic</option>
        </Select>
      </td>
      <td className="px-2 py-2">
        <Input aria-label={`${row.name}: longest lunch`} inputMode="numeric" placeholder={ph(inherit?.maxLunchMin) || "60"} value={lunch} onChange={(e) => setLunch(e.target.value)} />
      </td>
      <td className="px-2 py-2">
        <Input aria-label={`${row.name}: longest block`} inputMode="numeric" placeholder={ph(inherit?.maxBlockMin) || "120"} value={block} onChange={(e) => setBlock(e.target.value)} />
      </td>
      <td className="px-2 py-2">
        <Input aria-label={`${row.name}: notice days`} inputMode="numeric" placeholder={ph(inherit?.minNoticeDays) || "7"} value={notice} onChange={(e) => setNotice(e.target.value)} />
      </td>
      <td className="px-4 py-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveRulesAction(row.shopId, { timeOffApproval: approval || undefined, maxLunchMin: num(lunch), maxBlockMin: num(block), minNoticeDays: num(notice) }),
              () => "Saved",
            )
          }
        >
          Save
        </Button>
        {error && <div className="mt-1 max-w-48 text-xs text-red-600">{error}</div>}
        {ok && <div className="mt-1 text-xs text-emerald-700">{ok}</div>}
      </td>
    </tr>
  );
}

export function RulesEditor({
  brandWide,
  rules,
}: {
  brandWide: boolean;
  rules: { brand: StaffTimeRules; brandOverrides: Partial<StaffTimeRules>; shops: { id: string; name: string; overrides: Partial<StaffTimeRules>; effective: StaffTimeRules }[] };
}) {
  return (
    <Card>
      <CardHeader
        title="Rules"
        subtitle="Limits on what barbers block for themselves, how much notice time off needs (reasons set to need no notice, like Sick, are exempt), and who approves it. Blank follows the brand. Managers blocking someone else's time aren't held to the limits."
      />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500">
            <tr>
              <th className="px-4 py-2 font-medium">Where</th>
              <th className="px-2 py-2 font-medium">Time off approval</th>
              <th className="px-2 py-2 font-medium">Longest lunch (min)</th>
              <th className="px-2 py-2 font-medium">Longest block (min)</th>
              <th className="px-2 py-2 font-medium">Notice (days)</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {brandWide && <RuleRow row={{ key: "brand", shopId: null, name: "Brand default", overrides: rules.brandOverrides, effective: rules.brand }} inherit={null} />}
            {rules.shops.map((s) => (
              <RuleRow key={s.id} row={{ key: s.id, shopId: s.id, name: s.name, overrides: s.overrides, effective: s.effective }} inherit={rules.brand} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
