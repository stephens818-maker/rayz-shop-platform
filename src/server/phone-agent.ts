import "server-only";
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db, DBorTx } from "@/db";
import { appointments, callLogs, callTranscriptLines, notificationJobs, shops, type TranscriptSpeaker } from "@/db/schema";
import { maskPhone } from "@/domain/client-privacy";
import { ATTRIBUTION_DAYS, CallOutcome, PhoneOperator, callOutcome, cleanOperator, needsFollowUp, operatorMetrics } from "@/domain/phone-operator";
import { Actor, audit } from "./audit";
import { AppError, forbidden, notFound } from "./errors";
import { rows, uuids } from "./report-sql";
import { hasShop } from "./tenant";

/**
 * The phone agent's call log: every call to a shop's number with how it ended, the transcript of
 * what the agent said and what the caller pressed or said, the booking that followed, and a staff
 * follow-up. The agent itself is the keypad (and optional speech) menu in shop-line.ts.
 */

export interface PhoneViewer {
  brandWide: boolean;
  shopIds: string[];
}

/** Adds lines to a call's transcript, unless the shop keeps outcomes only. */
export async function transcribe(callLogId: string | null | undefined, op: Pick<PhoneOperator, "transcripts">, lines: [TranscriptSpeaker, string][], now = new Date(), tx: DBorTx = db) {
  const keep = lines.map(([speaker, text]) => ({ speaker, text: text.trim().slice(0, 1000) })).filter((l) => l.text);
  if (!callLogId || !op.transcripts || !keep.length) return;
  await tx.insert(callTranscriptLines).values(keep.map((l, i) => ({ callLogId, ...l, at: new Date(now.getTime() + i) })));
}

type CallRow = {
  id: string;
  shopId: string;
  shop: string;
  phone: string;
  customerId: string | null;
  client: string | null;
  operator: boolean;
  status: string;
  choice: string | null;
  digits: string | null;
  autoTextSent: boolean;
  durationSec: number | null;
  createdAt: Date;
  endedAt: Date | null;
  bookedCents: number | null;
  bookedAppointmentId: string | null;
  followedUpAt: Date | null;
  followUpNote: string | null;
  followedUpBy: string | null;
  lines: number;
  lastCallerLine: string | null;
};

export type AgentFilter = CallOutcome | "follow_up" | "agent" | "all";

/** Calls to the shops' numbers in the window, newest first, each with its outcome. */
export async function phoneAgentCalls(o: { shopIds: string[]; start: Date; end: Date; filter?: AgentFilter; limit?: number }) {
  if (!o.shopIds.length) return { calls: [], metrics: operatorMetrics([], 0), counts: {} as Partial<Record<AgentFilter, number>> };
  const all = await rows<CallRow>(callsSql(o.shopIds, o.start, o.end));
  const ops = new Map((await db.select({ id: shops.id, op: shops.phoneOperator }).from(shops)).map((s) => [s.id, cleanOperator(s.op)]));
  const calls = all.map((c) => {
    const outcome = callOutcome({ ...c, endedAt: c.endedAt });
    return { ...c, outcome, caller: c.client ?? maskPhone(c.phone) ?? "Unknown caller", phone: maskPhone(c.phone), followUp: needsFollowUp(outcome, c.status) && !c.followedUpAt };
  });
  const counts: Partial<Record<AgentFilter, number>> = { all: calls.length, agent: calls.filter((c) => c.operator).length, follow_up: calls.filter((c) => c.followUp).length };
  for (const c of calls) counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
  const f = o.filter ?? "all";
  const shown = calls.filter((c) => (f === "all" ? true : f === "agent" ? c.operator : f === "follow_up" ? c.followUp : c.outcome === f));
  const minutes = o.shopIds.reduce((a, id) => a + operatorMetrics(calls.filter((c) => c.shopId === id), ops.get(id)?.minutesPerCall ?? 3).minutesSaved, 0);
  return { calls: shown.slice(0, o.limit ?? 200), metrics: { ...operatorMetrics(calls, 0), minutesSaved: minutes }, counts };
}

function callsSql(shopIds: string[], start: Date, end: Date) {
  return sql`
    select c.id, c.shop_id "shopId", sh.name shop, c.phone, c.customer_id "customerId",
      nullif(trim(coalesce(cu.first_name, '') || ' ' || coalesce(cu.last_name, '')), '') client,
      c.operator, c.status, c.operator_choice choice, c.digits, c.auto_text_sent "autoTextSent", c.duration_sec "durationSec",
      c.created_at "createdAt", c.ended_at "endedAt", b.estimate_cents "bookedCents", b.id "bookedAppointmentId",
      c.followed_up_at "followedUpAt", c.follow_up_note "followUpNote", st.display_label "followedUpBy",
      (select count(*)::int from call_transcript_lines t where t.call_log_id = c.id) lines,
      (select t.text from call_transcript_lines t where t.call_log_id = c.id and t.speaker = 'caller' order by (t.text = 'Pressed nothing'), t.n desc limit 1) "lastCallerLine"
    from call_logs c
    join shops sh on sh.id = c.shop_id
    left join customers cu on cu.id = c.customer_id
    left join staff st on st.id = c.followed_up_by
    left join lateral (
      select a.id, coalesce(a.estimate_cents, 0)::int estimate_cents from appointments a join customers x on x.id = a.customer_id
      where c.operator and a.shop_id = c.shop_id and x.phone = c.phone and a.created_at >= c.created_at
        and a.created_at < c.created_at + ${sql.raw(`interval '${ATTRIBUTION_DAYS} days'`)} and a.status <> 'cancelled' and a.source <> 'walk_in'
      order by a.created_at limit 1
    ) b on true
    where c.shop_id in ${uuids(shopIds)} and c.direction = 'in' and c.kind = 'inbound' and c.created_at >= ${start.toISOString()}::timestamptz and c.created_at < ${end.toISOString()}::timestamptz
    order by c.created_at desc
    limit 2000`;
}

/** One call: its transcript, the texts the line sent the caller, and the booking that followed. */
export async function phoneAgentCall(v: PhoneViewer, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const call = await db.query.callLogs.findFirst({ where: eq(callLogs.id, id) });
  if (!call || call.kind !== "inbound" || !call.shopId || !(v.brandWide || hasShop(v, call.shopId))) return null;
  const until = new Date((call.endedAt ?? call.createdAt).getTime() + 10 * 60_000);
  const [lines, texts, [row]] = await Promise.all([
    db.select().from(callTranscriptLines).where(eq(callTranscriptLines.callLogId, id)).orderBy(asc(callTranscriptLines.n)),
    db
      .select({ id: notificationJobs.id, body: notificationJobs.body, status: notificationJobs.status, at: notificationJobs.createdAt })
      .from(notificationJobs)
      .where(and(eq(notificationJobs.shopId, call.shopId), eq(notificationJobs.to, call.phone), eq(notificationJobs.channel, "sms"), gte(notificationJobs.createdAt, call.createdAt), lte(notificationJobs.createdAt, until)))
      .orderBy(asc(notificationJobs.createdAt)),
    rows<CallRow>(sql`select * from (${callsSql([call.shopId], call.createdAt, new Date(call.createdAt.getTime() + 1))}) x where x.id = ${id}::uuid`),
  ]);
  const booked = row?.bookedAppointmentId ? await db.query.appointments.findFirst({ where: eq(appointments.id, row.bookedAppointmentId), columns: { id: true, shopId: true, code: true, startsAt: true, estimateCents: true } }) : null;
  const outcome = callOutcome({ operator: call.operator, status: call.status, choice: call.operatorChoice, autoTextSent: call.autoTextSent, bookedCents: row?.bookedCents ?? null, endedAt: call.endedAt });
  return {
    id: call.id,
    shop: row?.shop ?? "",
    caller: row?.client ?? maskPhone(call.phone) ?? "Unknown caller",
    customerId: call.customerId,
    phone: maskPhone(call.phone),
    operator: call.operator,
    status: call.status,
    durationSec: call.durationSec,
    createdAt: call.createdAt,
    endedAt: call.endedAt,
    outcome,
    followUp: needsFollowUp(outcome, call.status) && !call.followedUpAt,
    followedUpAt: call.followedUpAt,
    followedUpBy: row?.followedUpBy ?? null,
    followUpNote: call.followUpNote,
    lines,
    texts,
    booked,
  };
}

export const FollowUpInput = z.object({ id: z.uuid(), note: z.string().trim().max(500).optional().default(""), undo: z.boolean().optional().default(false) });

/** Someone at the shop followed up on a call (rang back, texted, booked them), or takes that back. */
export async function markFollowedUp(actor: Actor, v: PhoneViewer, raw: z.input<typeof FollowUpInput>, now = new Date()) {
  const c = FollowUpInput.parse(raw);
  const call = await db.query.callLogs.findFirst({ where: eq(callLogs.id, c.id) });
  if (!call || call.kind !== "inbound" || !call.shopId) throw notFound("Call");
  if (!(v.brandWide || hasShop(v, call.shopId))) throw forbidden("That call is at a shop outside your access");
  if (!c.undo && call.followedUpAt) throw new AppError("conflict", "Someone already followed up on that call");
  await db
    .update(callLogs)
    .set(c.undo ? { followedUpAt: null, followedUpBy: null, followUpNote: null } : { followedUpAt: now, followedUpBy: actor.staffId ?? null, followUpNote: c.note || null })
    .where(eq(callLogs.id, call.id));
  await audit(actor, c.undo ? "call.follow_up_undo" : "call.follow_up", "call_log", call.id, c.undo ? {} : { note: c.note || null }, call.shopId);
}

/** Each shop's phone agent settings, for the settings panel. */
export async function agentSettings(shopIds: string[]) {
  if (!shopIds.length) return [];
  const list = await db.select({ id: shops.id, name: shops.name, line: shops.twilioNumber, phone: shops.phone, op: shops.phoneOperator }).from(shops).where(sql`${shops.id} in ${uuids(shopIds)}`).orderBy(asc(shops.name));
  return list.map((s) => ({ id: s.id, name: s.name, hasLine: !!s.line, line: s.line, ringsShop: !!s.phone, op: cleanOperator(s.op) }));
}
