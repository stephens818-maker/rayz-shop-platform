import { and, desc, eq, inArray, isNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { payQuestions, shops, staff, type PayQuestionEvent } from "@/db/schema";
import type { Permission } from "@/domain/permissions";
import {
  PAY_QUESTION_MANAGER_DAYS,
  PAY_QUESTION_MAX_CHARS,
  PAY_QUESTION_MAX_OPEN,
  PAY_QUESTION_OWNER_DAYS,
  PAY_QUESTION_TOPICS,
  PAY_QUESTION_TOPIC_LABEL,
  type PayQuestionLevel,
  type PayQuestionTopic,
} from "@/domain/staff-privacy";
import { appBaseUrl } from "@/lib/deployment";
import { formatDate, isValidLocalDate } from "@/lib/time";
import { audit, SYSTEM, type Actor } from "./audit";
import { loadStaffAccess, staffWithAccessTo } from "./auth/access";
import { assertStaffAtShop } from "./checkout";
import { AppError, forbidden, notFound } from "./errors";
import { enqueueShopEmail } from "./notifications/queue";
import { queueStaffNotice } from "./staff-alerts";

/**
 * Pay questions (ST-I10): an employee asks about their pay; the managers who approve timecards at
 * that shop answer within PAY_QUESTION_MANAGER_DAYS, or it goes to the owners on its own, and the
 * employee can send it to the owners whenever the answer doesn't settle it. Emails carry the topic
 * and period, never the question itself; the history is kept as a pay record.
 */

const DAY = 86_400_000;
const ANSWER_PERMS: readonly Permission[] = ["timesheet.approve", "payroll.run", "payroll.export", "payroll.approve"];

export interface PayAsker {
  staffId: string;
  actor: Actor;
}
export interface PayViewer extends PayAsker {
  isOwner: boolean;
  shopIds: readonly string[];
  permissions: ReadonlySet<Permission>;
}

export const answersPayQuestions = (v: Pick<PayViewer, "isOwner" | "permissions">) => v.isOwner || ANSWER_PERMS.some((p) => v.permissions.has(p));
const answersEscalated = (v: Pick<PayViewer, "isOwner" | "permissions">) => v.isOwner || v.permissions.has("payroll.approve");

const bad = (m: string) => new AppError("bad_request", m);
const event = (kind: PayQuestionEvent["kind"], by: Actor | null, text: string | null, now: Date): PayQuestionEvent => ({
  at: now.toISOString(),
  kind,
  by: by?.staffId ?? null,
  byLabel: by?.label ?? "Ray'z",
  text,
});

/** Who answers at this level: the shop's timecard approvers and payroll people, or the owners. */
async function answerers(shopId: string, level: PayQuestionLevel, exclude: string) {
  const ids = (await staffWithAccessTo([shopId])).filter((id) => id !== exclude);
  const people = ids.length ? await db.select({ id: staff.id, email: staff.email, active: staff.active, kind: staff.kind }).from(staff).where(inArray(staff.id, ids)) : [];
  const out: string[] = [];
  for (const p of people) {
    if (!p.active || p.kind !== "person" || !p.email) continue;
    const a = await loadStaffAccess(p.id);
    if (a && (level === "owner" ? answersEscalated(a) : answersPayQuestions(a))) out.push(p.email);
  }
  return out;
}

async function tellAnswerers(q: typeof payQuestions.$inferSelect, who: string, why: string, now: Date) {
  const [shop] = await db.select({ name: shops.name }).from(shops).where(eq(shops.id, q.shopId));
  const topic = PAY_QUESTION_TOPIC_LABEL[q.topic as PayQuestionTopic] ?? q.topic;
  const period = q.periodStart ? ` for the pay period starting ${formatDate(q.periodStart)}` : "";
  for (const to of await answerers(q.shopId, q.level, q.staffId)) {
    await enqueueShopEmail(
      {
        kind: "pay_question",
        to,
        subject: q.level === "owner" ? `Pay question for the owners: ${topic}` : `Pay question: ${topic}`,
        body: `${who} ${why} about ${topic.toLowerCase()}${period} at ${shop?.name ?? "the shop"}. Please answer by ${formatDate(q.dueAt, "EEE MMM d")}: open the Ray'z Staff app, or ${appBaseUrl()}/admin/pay-questions.`,
        shopId: q.shopId,
      },
      db,
      now,
    );
  }
}

const tellAsker = (q: typeof payQuestions.$inferSelect, body: string, now: Date) => queueStaffNotice("pay_question", q.staffId, { body, shopId: q.shopId, now });

export async function askPayQuestion(asker: PayAsker, input: { shopId: string; periodStart?: string | null; topic: string; detail: string }, now = new Date()) {
  if (!(PAY_QUESTION_TOPICS as readonly string[]).includes(input.topic)) throw bad("Pick what the question is about.");
  const detail = input.detail.trim();
  if (!detail) throw bad("Say what looks wrong.");
  if (detail.length > PAY_QUESTION_MAX_CHARS) throw bad(`Keep it under ${PAY_QUESTION_MAX_CHARS} characters.`);
  if (input.periodStart && !isValidLocalDate(input.periodStart)) throw bad("Pick a pay period.");
  const me = await db.query.staff.findFirst({ where: eq(staff.id, asker.staffId), columns: { kind: true, active: true, displayLabel: true } });
  if (!me?.active || me.kind !== "person") throw forbidden("Shop logins can't ask pay questions.");
  await assertStaffAtShop(asker.staffId, input.shopId);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(payQuestions)
    .where(and(eq(payQuestions.staffId, asker.staffId), ne(payQuestions.status, "resolved")));
  if (n >= PAY_QUESTION_MAX_OPEN) throw new AppError("conflict", `You have ${n} pay questions open. Close the answered ones first, or talk to your manager.`);
  const [row] = await db
    .insert(payQuestions)
    .values({
      staffId: asker.staffId,
      shopId: input.shopId,
      periodStart: input.periodStart ?? null,
      topic: input.topic,
      detail,
      dueAt: new Date(now.getTime() + PAY_QUESTION_MANAGER_DAYS * DAY),
      history: [event("asked", asker.actor, detail, now)],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  await audit(asker.actor, "pay_question.ask", "pay_question", row.id, { topic: row.topic, periodStart: row.periodStart }, row.shopId);
  await tellAnswerers(row, me.displayLabel, "asked a pay question", now);
  return view(row, { shop: null, label: me.displayLabel }, null);
}

type Row = typeof payQuestions.$inferSelect;
function view(q: Row, names: { shop: string | null; label: string | null }, viewer: PayViewer | null) {
  return {
    id: q.id,
    staffId: q.staffId,
    staff: names.label,
    shopId: q.shopId,
    shop: names.shop,
    periodStart: q.periodStart,
    topic: q.topic,
    topicLabel: PAY_QUESTION_TOPIC_LABEL[q.topic as PayQuestionTopic] ?? q.topic,
    detail: q.detail,
    status: q.status,
    level: q.level,
    dueAt: q.dueAt,
    overdue: q.status === "open" && q.dueAt.getTime() < Date.now(),
    escalatedAt: q.escalatedAt,
    history: q.history,
    createdAt: q.createdAt,
    canEscalate: viewer === null ? q.level === "manager" && q.status !== "resolved" : false,
    canAnswer: viewer ? q.status !== "resolved" && q.staffId !== viewer.staffId && (q.level === "owner" ? answersEscalated(viewer) : answersPayQuestions(viewer)) : false,
  };
}

/** Their own questions, newest first. */
export async function myPayQuestions(staffId: string) {
  const rows = await db
    .select({ q: payQuestions, shop: shops.name })
    .from(payQuestions)
    .innerJoin(shops, eq(shops.id, payQuestions.shopId))
    .where(eq(payQuestions.staffId, staffId))
    .orderBy(desc(payQuestions.createdAt));
  return rows.map((r) => view(r.q, { shop: r.shop, label: null }, null));
}

async function ownRow(staffId: string, id: string) {
  const q = await db.query.payQuestions.findFirst({ where: eq(payQuestions.id, id) });
  if (!q || q.staffId !== staffId) throw notFound("Pay question");
  return q;
}

/** The employee sends it to the owners: not answered, or the answer didn't settle it. */
export async function escalatePayQuestion(asker: PayAsker, id: string, note: string | null, now = new Date()) {
  const q = await ownRow(asker.staffId, id);
  if (q.status === "resolved") throw new AppError("conflict", "That question is closed. Ask a new one.");
  if (q.level === "owner") throw new AppError("conflict", "It's already with the owners.");
  const text = note?.trim().slice(0, PAY_QUESTION_MAX_CHARS) || null;
  const row = await escalate(q, asker.actor, text, now);
  await audit(asker.actor, "pay_question.escalate", "pay_question", id, { by: "employee" }, q.shopId);
  const me = await db.query.staff.findFirst({ where: eq(staff.id, asker.staffId), columns: { displayLabel: true } });
  await tellAnswerers(row, me?.displayLabel ?? "An employee", "sent a pay question to the owners", now);
  return view(row, { shop: null, label: null }, null);
}

async function escalate(q: Row, by: Actor | null, text: string | null, now: Date) {
  const [row] = await db
    .update(payQuestions)
    .set({
      level: "owner",
      status: "open",
      escalatedAt: now,
      dueAt: new Date(now.getTime() + PAY_QUESTION_OWNER_DAYS * DAY),
      history: sql`${payQuestions.history} || ${JSON.stringify([event("escalated", by, text, now)])}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(payQuestions.id, q.id), eq(payQuestions.level, "manager")))
    .returning();
  if (!row) throw new AppError("conflict", "It's already with the owners.");
  return row;
}

/** The employee closes it: the answer settled it. */
export async function resolvePayQuestion(asker: PayAsker, id: string, now = new Date()) {
  const q = await ownRow(asker.staffId, id);
  if (q.status === "resolved") return view(q, { shop: null, label: null }, null);
  const [row] = await db
    .update(payQuestions)
    .set({ status: "resolved", history: sql`${payQuestions.history} || ${JSON.stringify([event("resolved", asker.actor, null, now)])}::jsonb`, updatedAt: now })
    .where(eq(payQuestions.id, id))
    .returning();
  await audit(asker.actor, "pay_question.resolve", "pay_question", id, {}, q.shopId);
  return view(row, { shop: null, label: null }, null);
}

/** The questions at the viewer's shops (never their own), open ones first. */
export async function teamPayQuestions(v: PayViewer, o: { open?: boolean } = {}) {
  if (!answersPayQuestions(v)) throw forbidden("You can't see the team's pay questions.");
  if (!v.shopIds.length) return [];
  const rows = await db
    .select({ q: payQuestions, shop: shops.name, label: staff.displayLabel })
    .from(payQuestions)
    .innerJoin(shops, eq(shops.id, payQuestions.shopId))
    .innerJoin(staff, eq(staff.id, payQuestions.staffId))
    .where(and(inArray(payQuestions.shopId, [...v.shopIds]), ne(payQuestions.staffId, v.staffId), o.open ? ne(payQuestions.status, "resolved") : undefined))
    .orderBy(sql`case ${payQuestions.status} when 'open' then 0 when 'answered' then 1 else 2 end`, payQuestions.dueAt);
  return rows.map((r) => view(r.q, { shop: r.shop, label: r.label }, v));
}

/** A manager answers (or, once escalated, an owner). The employee hears there's an answer. */
export async function answerPayQuestion(v: PayViewer, id: string, answer: string, now = new Date()) {
  const text = answer.trim();
  if (!text) throw bad("Write the answer.");
  if (text.length > PAY_QUESTION_MAX_CHARS) throw bad(`Keep it under ${PAY_QUESTION_MAX_CHARS} characters.`);
  const q = await db.query.payQuestions.findFirst({ where: eq(payQuestions.id, id) });
  if (!q || !v.shopIds.includes(q.shopId) || q.staffId === v.staffId) throw notFound("Pay question");
  if (q.status === "resolved") throw new AppError("conflict", "They closed this question.");
  if (q.level === "owner" ? !answersEscalated(v) : !answersPayQuestions(v)) throw forbidden(q.level === "owner" ? "This question is with the owners." : "You can't answer pay questions.");
  const [row] = await db
    .update(payQuestions)
    .set({ status: "answered", history: sql`${payQuestions.history} || ${JSON.stringify([event("answered", v.actor, text, now)])}::jsonb`, updatedAt: now })
    .where(eq(payQuestions.id, id))
    .returning();
  await audit(v.actor, "pay_question.answer", "pay_question", id, { level: q.level }, q.shopId);
  const topic = PAY_QUESTION_TOPIC_LABEL[q.topic as PayQuestionTopic] ?? q.topic;
  await tellAsker(
    row,
    `Your pay question about ${topic.toLowerCase()} has an answer. Open the app to read it${row.level === "manager" ? ", and send it to the owners if it doesn't settle it" : ""}.`,
    now,
  );
  return view(row, { shop: null, label: null }, v);
}

/**
 * From cron: a manager-level question with no answer by its due time goes to the owners (and the
 * employee hears so); an overdue one with the owners gets one reminder to them.
 */
export async function payQuestionCron(now = new Date()) {
  const out = { escalated: 0, reminded: 0 };
  const overdue = await db
    .select()
    .from(payQuestions)
    .where(and(eq(payQuestions.status, "open"), lte(payQuestions.dueAt, now)));
  for (const q of overdue) {
    if (q.level === "manager") {
      const row = await escalate(q, null, `No answer in ${PAY_QUESTION_MANAGER_DAYS} days.`, now).catch(() => null);
      if (!row) continue;
      await audit(SYSTEM, "pay_question.escalate", "pay_question", q.id, { by: "overdue" }, q.shopId);
      const who = await db.query.staff.findFirst({ where: eq(staff.id, q.staffId), columns: { displayLabel: true } });
      await tellAnswerers(row, who?.displayLabel ?? "An employee", `has had no answer for ${PAY_QUESTION_MANAGER_DAYS} days to a pay question`, now);
      await tellAsker(row, "Nobody answered your pay question in time, so it went to the owners.", now);
      out.escalated++;
    } else if (!q.remindedAt) {
      const [row] = await db
        .update(payQuestions)
        .set({ remindedAt: now, history: sql`${payQuestions.history} || ${JSON.stringify([event("reminded", null, null, now)])}::jsonb`, updatedAt: now })
        .where(and(eq(payQuestions.id, q.id), isNull(payQuestions.remindedAt)))
        .returning();
      if (!row) continue;
      const who = await db.query.staff.findFirst({ where: eq(staff.id, q.staffId), columns: { displayLabel: true } });
      await tellAnswerers(row, who?.displayLabel ?? "An employee", "is still waiting on the owners for a pay question", now);
      out.reminded++;
    }
  }
  return out;
}
