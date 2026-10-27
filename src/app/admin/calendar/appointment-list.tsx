"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { GroupLinkIcon } from "@/components/group-options";
import { STATUS_LABEL, Select, StatusBadge, Table, Td, Th } from "@/components/ui";
import { BOOKING_METHOD_LABEL, type BookingMethod } from "@/domain/appointment-report";
import type { ListStatus, ListedAppointment } from "@/server/appointment-list";
import { ViewToggle } from "./day-calendar";

const STATUS_CHOICES: { key: ListStatus; label: string }[] = [
  { key: "all", label: "All" },
  { key: "upcoming", label: "Still to come" },
  { key: "completed", label: "Completed" },
  { key: "missed", label: "Cancelled and no-shows" },
];

function time(min: number) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}
const shiftDate = (d: string, n: number) => {
  const dt = new Date(`${d}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const dayLabel = (d: string) =>
  new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

export function AppointmentList(p: {
  shop: string;
  rows: ListedAppointment[];
  date: string;
  days: 1 | 7;
  today: string;
  status: ListStatus;
  staffId: string | null;
  barbers: { id: string; name: string }[] | null;
  links: { clients: boolean; sales: boolean };
}) {
  const router = useRouter();
  const go = (x: Partial<{ date: string; days: number; status: ListStatus; staff: string | null }>) => {
    const n = { date: p.date, days: p.days, status: p.status, staff: p.staffId, ...x };
    router.push(
      `/admin/calendar?${new URLSearchParams({
        view: "list",
        date: n.date,
        ...(n.days === 7 ? { days: "7" } : {}),
        ...(n.status !== "all" ? { status: n.status } : {}),
        ...(n.staff ? { staff: n.staff } : {}),
      })}`,
    );
  };
  const last = shiftDate(p.date, p.days - 1);
  const title = p.days === 1 ? dayLabel(p.date) : `${dayLabel(p.date)} – ${dayLabel(last)}`;
  const counts = new Map<string, number>();
  for (const r of p.rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">{p.shop}</div>
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {p.barbers && (
            <Select aria-label="Barber" value={p.staffId ?? ""} onChange={(e) => go({ staff: e.target.value || null })} className="h-9 w-auto py-0">
              <option value="">Every barber</option>
              {p.barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label="Show" value={p.status} onChange={(e) => go({ status: e.target.value as ListStatus })} className="h-9 w-auto py-0">
            {STATUS_CHOICES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select aria-label="Days" value={String(p.days)} onChange={(e) => go({ days: Number(e.target.value) })} className="h-9 w-auto py-0">
            <option value="1">One day</option>
            <option value="7">Seven days</option>
          </Select>
          <div className="flex rounded-lg ring-1 ring-zinc-300">
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go({ date: shiftDate(p.date, -p.days) })} aria-label={p.days === 1 ? "Previous day" : "Previous seven days"}>
              ‹
            </button>
            <button className="h-9 border-x border-zinc-300 px-3 text-sm font-medium hover:bg-zinc-100" onClick={() => go({ date: p.today })}>
              Today
            </button>
            <button className="h-9 px-3 text-sm hover:bg-zinc-100" onClick={() => go({ date: shiftDate(p.date, p.days) })} aria-label={p.days === 1 ? "Next day" : "Next seven days"}>
              ›
            </button>
          </div>
          <ViewToggle view="list" date={p.date} staffId={p.staffId} />
        </div>
      </div>

      <p className="text-sm text-zinc-600" data-testid="list-summary">
        {p.rows.length.toLocaleString("en-US")} appointment{p.rows.length === 1 ? "" : "s"}
        {p.rows.length > 0 &&
          ` · ${[...counts.entries()]
            .map(([s, n]) => `${n} ${(STATUS_LABEL[s] ?? s).toLowerCase()}`)
            .join(", ")}`}
        {p.rows.length >= 1000 && " (the first 1,000; narrow the days or pick a barber)"}
      </p>

      {p.rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 bg-white px-6 py-12 text-center text-sm text-zinc-500">No appointments match.</div>
      ) : (
        <div className="overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
          <Table label="Appointments">
            <thead>
              <tr>
                {p.days > 1 && <Th>Day</Th>}
                <Th>Time</Th>
                <Th>Client</Th>
                <Th>Barber</Th>
                <Th>Services</Th>
                <Th>Status</Th>
                <Th>Booked</Th>
                <Th>
                  <span className="sr-only">Open</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {p.rows.map((r, i) => (
                <tr key={r.id} className="hover:bg-zinc-50" data-testid="list-row">
                  {p.days > 1 && <Td className="text-zinc-600">{i === 0 || p.rows[i - 1].date !== r.date ? dayLabel(r.date) : ""}</Td>}
                  <Td className="tabular-nums">
                    {time(r.startMin)}
                    <span className="text-zinc-500"> – {time(r.endMin)}</span>
                  </Td>
                  <Td>
                    {r.customerId && p.links.clients ? (
                      <Link className="font-medium hover:underline" href={`/admin/customers/${r.customerId}`}>
                        {r.customerName}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.customerName}</span>
                    )}
                    {r.groupId && <GroupLinkIcon title="Booked together" className="ml-1 inline size-3.5 text-zinc-500" />}
                  </Td>
                  <Td>{r.barber}</Td>
                  <Td className="max-w-[18rem] truncate">
                    <span title={r.services.join(", ")}>{r.services.join(", ") || "—"}</span>
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="text-zinc-600">{BOOKING_METHOD_LABEL[r.source as BookingMethod] ?? r.source}</Td>
                  <Td right>
                    <span className="inline-flex gap-3">
                      {r.saleId && p.links.sales && (
                        <Link className="text-sm underline" href={`/admin/sales/${r.saleId}`}>
                          Ticket
                        </Link>
                      )}
                      <Link className="text-sm underline" href={`/admin/calendar?${new URLSearchParams({ date: r.date, appt: r.id })}`}>
                        Open
                      </Link>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </div>
  );
}
