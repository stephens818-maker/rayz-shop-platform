import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Select, Stat, Table, Td, Th, buttonClass, cx } from "@/components/ui";
import { CALL_OUTCOME_LABEL, CALL_OUTCOME_TONE, OPERATOR_ANSWER_LABEL, type CallOutcome, formatCallLength } from "@/domain/phone-operator";
import { reportView } from "@/domain/permissions";
import { formatCents } from "@/lib/money";
import { addDays, formatDateTime, formatTime, localDateOf, startOfLocalDay, todayLocal } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { clientPolicy } from "@/server/client-privacy";
import { type AgentFilter, agentSettings, phoneAgentCall, phoneAgentCalls } from "@/server/phone-agent";
import { PhoneOperatorEditor } from "../settings/part-editors";
import { FollowUp } from "./follow-up";

export const metadata: Metadata = { title: "Phone agent" };

const RANGES = { "1": "Today", "7": "Last 7 days", "30": "Last 30 days", "90": "Last 90 days" } as const;
const FILTERS: [AgentFilter, string][] = [
  ["all", "Every call"],
  ["follow_up", "Needs a follow-up"],
  ["agent", "Taken by the agent"],
  ["booked", CALL_OUTCOME_LABEL.booked],
  ["link_texted", CALL_OUTCOME_LABEL.link_texted],
  ["put_through", CALL_OUTCOME_LABEL.put_through],
  ["hours", CALL_OUTCOME_LABEL.hours],
  ["hung_up", CALL_OUTCOME_LABEL.hung_up],
  ["staff_answered", CALL_OUTCOME_LABEL.staff_answered],
  ["missed", CALL_OUTCOME_LABEL.missed],
  ["after_hours", CALL_OUTCOME_LABEL.after_hours],
];
const SPEAKER = { agent: "Agent", caller: "Caller", line: "Line" } as const;
const pct = (x: number | null) => (x == null ? "—" : `${Math.round(x * 100)}%`);

export default async function PhoneAgentPage({ searchParams }: { searchParams: Promise<{ shop?: string; days?: string; show?: string; call?: string }> }) {
  const ctx = await guardPage("/admin/phone-agent");
  const sp = await searchParams;
  const shops = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const shopId = shops.some((s) => s.id === sp.shop) ? sp.shop! : null;
  const inView = shopId ? [shopId] : shops.map((s) => s.id);
  const days = (sp.days && sp.days in RANGES ? sp.days : "7") as keyof typeof RANGES;
  const filter = (FILTERS.some(([k]) => k === sp.show) ? sp.show : "all") as AgentFilter;
  const seeCalls = can(ctx, reportView("phone_operator"));
  const editSettings = can(ctx, "settings.shop") || can(ctx, "settings.shop_phone");
  const today = todayLocal();
  const start = startOfLocalDay(addDays(today, 1 - Number(days)));
  const end = startOfLocalDay(addDays(today, 1));
  const { name } = await clientPolicy(ctx);
  const [data, detail, settings] = await Promise.all([
    seeCalls ? phoneAgentCalls({ shopIds: inView, start, end, filter, name }) : null,
    seeCalls && sp.call ? phoneAgentCall({ brandWide: ctx.brandWide, shopIds: ctx.shopIds, name }, sp.call) : null,
    agentSettings(inView),
  ]);
  const href = (o: Partial<Record<"shop" | "days" | "show" | "call", string | null>>) => {
    const q = new URLSearchParams();
    const v = { shop: shopId, days, show: filter === "all" ? null : filter, call: null, ...o };
    for (const [k, x] of Object.entries(v)) if (x && !(k === "days" && x === "7")) q.set(k, x);
    const s = q.toString();
    return `/admin/phone-agent${s ? `?${s}` : ""}`;
  };
  const m = data?.metrics;
  const off = settings.filter((s) => !s.op.enabled);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Phone agent"
        subtitle="Answers each shop's number when nobody at the shop can: texts a booking link, reads the hours, or puts the caller through. Every call's outcome and transcript, and the calls someone should ring back."
        actions={
          <form method="get" className="flex flex-wrap items-center gap-2">
            <Select name="shop" defaultValue={shopId ?? ""} className="w-48" aria-label="Shop">
              <option value="">{ctx.brandWide ? "Shop (all)" : "All my shops"}</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select name="days" defaultValue={days} className="w-40" aria-label="Period">
              {Object.entries(RANGES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            {filter !== "all" && <input type="hidden" name="show" value={filter} />}
            <button type="submit" className={buttonClass("secondary", "sm")}>
              Show
            </button>
          </form>
        }
      />

      {off.length > 0 && (
        <Notice tone="amber">
          The agent is off at {off.map((s) => s.name).join(", ")}. Calls there still ring the shop and are logged; missed and after-hours calls just get the text.
        </Notice>
      )}

      {m && (
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat label="Calls in" value={m.calls} hint={`${m.staffAnswered} answered by staff`} />
          <Stat label="Taken by the agent" value={m.handled} hint={`${m.linksTexted} booking links texted`} />
          <Stat label="Booked after" value={m.bookings} hint={`${formatCents(m.bookedCents)} · ${pct(m.bookRate)} book rate`} />
          <Stat label="Calls answered" value={pct(m.answerRate)} hint="By staff or the agent" />
          <Stat label="Needs a follow-up" value={data.counts.follow_up ?? 0} tone={data.counts.follow_up ? "down" : undefined} hint="Missed, hung up, or put through and missed" />
          <Stat label="Staff minutes saved" value={m.minutesSaved} hint={`${(m.minutesSaved / 60).toFixed(1)} hours`} />
        </div>
      )}

      {detail && (
        <Card>
          <CardHeader
            title={
              <span className="flex flex-wrap items-center gap-2">
                {detail.customerId ? (
                  <Link className="underline" href={`/admin/customers/${detail.customerId}`}>
                    {detail.caller}
                  </Link>
                ) : (
                  detail.caller
                )}
                <Badge tone={CALL_OUTCOME_TONE[detail.outcome]}>{CALL_OUTCOME_LABEL[detail.outcome]}</Badge>
                {detail.followUp && <Badge tone="red">Needs a follow-up</Badge>}
              </span>
            }
            subtitle={`${detail.shop} · ${formatDateTime(detail.createdAt)} · ${detail.operator ? "taken by the agent" : "rang the shop"}${detail.durationSec ? ` · ${formatCallLength(detail.durationSec)}` : ""}${detail.phone && detail.customerId ? ` · ${detail.phone}` : ""}`}
            action={
              <Link className="text-xs underline" href={href({})}>
                Close
              </Link>
            }
          />
          <div className="grid gap-4 p-4 md:grid-cols-[1fr_18rem]">
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Transcript</div>
              {detail.lines.length === 0 ? (
                <p className="text-sm text-zinc-500">No transcript for this call: it came in before transcripts, or the shop keeps outcomes only.</p>
              ) : (
                <ol className="space-y-2">
                  {detail.lines.map((l) => (
                    <li key={l.id} className={cx("flex gap-3 text-sm", l.speaker === "line" && "text-zinc-500")}>
                      <span className="w-14 shrink-0 text-xs tabular-nums text-zinc-400">{formatTime(l.at)}</span>
                      <span className={cx("w-14 shrink-0 text-xs font-medium", l.speaker === "agent" ? "text-violet-700" : l.speaker === "caller" ? "text-blue-700" : "text-zinc-400")}>{SPEAKER[l.speaker]}</span>
                      <span className={cx("min-w-0 flex-1", l.speaker === "line" && "italic")}>{l.text}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <div className="space-y-3 text-sm">
              {detail.booked && (
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Booking that followed</div>
                  <Link className="underline" href={`/admin/calendar?date=${localDateOf(detail.booked.startsAt)}&shop=${detail.booked.shopId}&appt=${detail.booked.id}`}>
                    {detail.booked.code}
                  </Link>{" "}
                  for {formatDateTime(detail.booked.startsAt)} · {formatCents(detail.booked.estimateCents ?? 0)}
                </div>
              )}
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Texts sent</div>
                {detail.texts.length === 0 ? (
                  <p className="text-zinc-500">None</p>
                ) : (
                  detail.texts.map((t) => (
                    <p key={t.id} className="mt-1 rounded-lg bg-zinc-50 px-2 py-1.5 text-xs text-zinc-700">
                      {t.body}
                      <span className="block text-zinc-400">
                        {formatTime(t.at)} · {t.status}
                      </span>
                    </p>
                  ))
                )}
              </div>
              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Follow-up</div>
                {detail.followedUpAt && (
                  <p className="text-zinc-700">
                    {detail.followedUpBy ?? "Someone"}, {formatDateTime(detail.followedUpAt)}
                    {detail.followUpNote ? `: ${detail.followUpNote}` : ""}
                  </p>
                )}
                <div className="mt-1">
                  <FollowUp id={detail.id} done={!!detail.followedUpAt} flagged={detail.followUp} />
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {data && (
        <Card>
          <CardHeader title="Call log" subtitle={`${RANGES[days]}, newest first. Callers show by name when they're a client; other numbers stay masked.`} />
          <div className="flex flex-wrap gap-1.5 border-b border-zinc-100 px-4 py-2">
            {FILTERS.filter(([k]) => k === "all" || k === filter || (data.counts[k] ?? 0) > 0).map(([k, label]) => (
              <Link key={k} href={href({ show: k === "all" ? null : k })} className={cx("rounded-full px-2.5 py-1 text-xs ring-1", k === filter ? "bg-zinc-900 text-white ring-zinc-900" : "text-zinc-700 ring-zinc-200 hover:bg-zinc-50")}>
                {label} <span className="tabular-nums opacity-70">{data.counts[k] ?? 0}</span>
              </Link>
            ))}
          </div>
          {data.calls.length === 0 ? (
            <Empty title="No calls here" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  {!shopId && <Th>Shop</Th>}
                  <Th>Caller</Th>
                  <Th>Answered by</Th>
                  <Th>Outcome</Th>
                  <Th>Caller said</Th>
                  <Th right>Length</Th>
                  <Th>Follow-up</Th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr key={c.id} className={detail?.id === c.id ? "bg-amber-50" : undefined}>
                    <Td className="text-xs">
                      <Link className="underline" href={href({ call: c.id })}>
                        {formatDateTime(c.createdAt)}
                      </Link>
                    </Td>
                    {!shopId && <Td>{c.shop}</Td>}
                    <Td>{c.caller}</Td>
                    <Td>{c.operator ? "Agent" : c.status === "answered" ? "Staff" : "—"}</Td>
                    <Td>
                      <Badge tone={CALL_OUTCOME_TONE[c.outcome as CallOutcome]}>{CALL_OUTCOME_LABEL[c.outcome as CallOutcome]}</Badge>
                      {c.bookedCents !== null && <span className="ml-1 text-xs text-zinc-500">{formatCents(c.bookedCents)}</span>}
                    </Td>
                    <Td className="max-w-56 truncate text-xs text-zinc-600">{c.lastCallerLine ?? (c.digits ? `Pressed ${c.digits}` : "—")}</Td>
                    <Td right className="text-xs tabular-nums">
                      {formatCallLength(c.durationSec)}
                    </Td>
                    <Td className="text-xs">
                      {c.followedUpAt ? (
                        <span className="text-emerald-700">Done{c.followedUpBy ? `, ${c.followedUpBy}` : ""}</span>
                      ) : c.followUp ? (
                        <Link className="font-medium text-red-700 underline" href={href({ call: c.id })}>
                          Ring back
                        </Link>
                      ) : (
                        "—"
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <div id="settings" className="space-y-3">
        {shopId && editSettings && settings[0] ? (
          <PhoneOperatorEditor shopId={settings[0].id} initial={settings[0].op} hasLine={settings[0].hasLine} />
        ) : (
          <Card>
            <CardHeader title="Settings" subtitle={editSettings ? "Pick a shop to change how its agent answers." : "How each shop's agent answers."} />
            <Table>
              <thead>
                <tr>
                  <Th>Shop</Th>
                  <Th>Agent</Th>
                  <Th>Answers</Th>
                  <Th>Speech</Th>
                  <Th>Transcripts</Th>
                  <Th>Minutes per call</Th>
                  {editSettings && <Th />}
                </tr>
              </thead>
              <tbody>
                {settings.map((s) => (
                  <tr key={s.id}>
                    <Td>{s.name}</Td>
                    <Td>{!s.hasLine ? <Badge>No Twilio number</Badge> : s.op.enabled ? <Badge tone="green">On</Badge> : <Badge tone="amber">Off</Badge>}</Td>
                    <Td className="text-xs">{OPERATOR_ANSWER_LABEL[s.op.answer]}</Td>
                    <Td>{s.op.speech ? "Keys or speech" : "Keys only"}</Td>
                    <Td>{s.op.transcripts ? "Kept" : "Outcome only"}</Td>
                    <Td className="tabular-nums">{s.op.minutesPerCall}</Td>
                    {editSettings && (
                      <Td>
                        <Link className="text-xs underline" href={`${href({ shop: s.id })}#settings`}>
                          Edit
                        </Link>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </Table>
          </Card>
        )}
        {seeCalls && (
          <p className="text-xs text-zinc-500">
            Bookings, book rate and minutes saved by shop and day are on the{" "}
            <Link className="underline" href="/admin/reports/phone-operator">
              Phone operator report
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
