/**
 * ST-I10 against a real database: an employee's pay question goes to the managers who approve
 * timecards at the shop (emails carry the topic, never the question), the employee can escalate it to
 * the owners, an unanswered one goes there on its own, escalated ones are answered by owners only,
 * and the notice's deletions run: signed-out phones and old punch photos.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";
import { staffApp } from "./staff-app";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let api: Awaited<ReturnType<typeof staffApp>>;
let pq: typeof import("@/server/pay-questions");
const ids: Record<string, string> = {};

const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const S = () => m.schema;
const DAY = 86_400_000;

beforeAll(async () => {
  m = await loadModules();
  api = await staffApp();
  pq = await import("@/server/pay-questions");
  for (const e of ["makenna", "michelle", "owner", "kat"]) ids[e] = (await m.db.db.query.staff.findFirst({ where: eq(S().staff.email, `${e}@rayz.test`) }))!.id;
  for (const s of ["coralville", "moline"]) ids[s] = (await m.db.db.query.shops.findFirst({ where: eq(S().shops.slug, s) }))!.id;
}, 240_000);

afterAll(async () => {
  await m?.db.closeDb();
});

const mails = async (subject: string) => (await m.db.db.select().from(S().notificationJobs).where(eq(S().notificationJobs.kind, "pay_question"))).filter((j) => j.channel === "email" && j.subject?.startsWith(subject));

describe("pay questions (ST-I10)", () => {
  it("goes to the shop's managers, is answered, escalated to the owners and closed, with the history kept", async () => {
    const mk = await api.login("makenna@rayz.test");
    const detail = "My Nov 3 shift is missing 2 hours; I clocked in at the front desk.";
    const bad = await api.call("POST", "me/pay-questions", { token: mk.accessToken, body: { shopId: ids.moline, topic: "hours", detail } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/team|work at/i);
    const asked = await api.call("POST", "me/pay-questions", { token: mk.accessToken, body: { shopId: ids.coralville, periodStart: "2026-11-02", topic: "hours", detail } });
    expect(asked.status).toBe(201);
    expect(asked.json).toMatchObject({ status: "open", level: "manager", topicLabel: "Hours or punches", canEscalate: true });
    const id = asked.json.id as string;

    const toManagers = await mails("Pay question: Hours");
    expect(toManagers.map((j) => j.to)).toEqual(expect.arrayContaining(["michelle@rayz.test", "owner@rayz.test"]));
    expect(toManagers.map((j) => j.to)).not.toContain("makenna@rayz.test");
    expect(toManagers.map((j) => j.to)).not.toContain("manager.moline@rayz.test");
    for (const j of toManagers) expect(j.body).not.toContain("missing 2 hours");

    const own = await api.call("POST", `pay-questions/${id}/answer`, { token: mk.accessToken, body: { answer: "self" } });
    expect(own.status).toBe(403);
    const kat = await api.login("kat@rayz.test");
    expect((await api.call("GET", "pay-questions", { token: kat.accessToken })).json?.questions?.some((q: { id: string }) => q.id === id) ?? false).toBe(false);

    const mgr = await api.login("michelle@rayz.test");
    const list = await api.call("GET", "pay-questions?open=true", { token: mgr.accessToken });
    expect(list.status).toBe(200);
    expect(list.json.questions.find((q: { id: string }) => q.id === id)).toMatchObject({ staff: expect.any(String), canAnswer: true, detail });
    const answered = await api.call("POST", `pay-questions/${id}/answer`, { token: mgr.accessToken, body: { answer: "The front-desk punch was on the Moline tablet; I moved it." } });
    expect(answered.status).toBe(200);
    expect(answered.json.status).toBe("answered");

    const up = await api.call("POST", `me/pay-questions/${id}/escalate`, { token: mk.accessToken, body: { note: "Still short on the paystub." } });
    expect(up.json).toMatchObject({ level: "owner", status: "open", canEscalate: false });
    expect((await api.call("POST", `me/pay-questions/${id}/escalate`, { token: mk.accessToken, body: {} })).status).toBe(409);
    expect((await mails("Pay question for the owners")).map((j) => j.to)).toContain("owner@rayz.test");
    expect((await mails("Pay question for the owners")).map((j) => j.to)).not.toContain("michelle@rayz.test");

    const mgrAgain = await api.call("POST", `pay-questions/${id}/answer`, { token: mgr.accessToken, body: { answer: "again" } });
    expect(mgrAgain.status).toBe(403);
    const owner = await api.login("owner@rayz.test");
    expect((await api.call("POST", `pay-questions/${id}/answer`, { token: owner.accessToken, body: { answer: "Paid on the next payday with a note on the timecard." } })).status).toBe(200);
    const closed = await api.call("POST", `me/pay-questions/${id}/resolve`, { token: mk.accessToken });
    expect(closed.json.status).toBe("resolved");

    const mine = await api.call("GET", "me/pay-questions", { token: mk.accessToken });
    expect(mine.json.questions[0].history.map((h: { kind: string }) => h.kind)).toEqual(["asked", "answered", "escalated", "answered", "resolved"]);
    const audits = await m.db.db.select().from(S().auditLog).where(eq(S().auditLog.entityId, id));
    expect(audits.map((a) => a.action).sort()).toEqual(["pay_question.answer", "pay_question.answer", "pay_question.ask", "pay_question.escalate", "pay_question.resolve"]);
  });

  it("an unanswered question goes to the owners on its own, and an overdue escalation reminds them once", async () => {
    const asker = { staffId: ids.makenna, actor: { staffId: ids.makenna, label: "Makenna" } };
    const now = new Date();
    const q = await pq.askPayQuestion(asker, { shopId: ids.coralville, topic: "tips", detail: "Card tips look low." }, now);
    expect((await pq.payQuestionCron(new Date(now.getTime() + 4 * DAY))).escalated).toBe(0);
    const later = new Date(now.getTime() + 6 * DAY);
    expect(await pq.payQuestionCron(later)).toMatchObject({ escalated: 1 });
    const row = (await m.db.db.query.payQuestions.findFirst({ where: eq(S().payQuestions.id, q.id) }))!;
    expect(row).toMatchObject({ level: "owner", status: "open" });
    expect(row.history.at(-1)).toMatchObject({ kind: "escalated", by: null, byLabel: "Ray'z" });
    const end = new Date(later.getTime() + 8 * DAY);
    expect(await pq.payQuestionCron(end)).toMatchObject({ reminded: 1 });
    expect(await pq.payQuestionCron(new Date(end.getTime() + DAY))).toMatchObject({ escalated: 0, reminded: 0 });
    await pq.resolvePayQuestion(asker, q.id);
  });

  it("scrubs a card or SSN typed into the question or an answer, keeping the history's ids and times", async () => {
    const asker = { staffId: ids.makenna, actor: { staffId: ids.makenna, label: "Makenna" } };
    const q = await pq.askPayQuestion(asker, { shopId: ids.coralville, topic: "deductions", detail: "Deposit to card 4242 4242 4242 4242, SSN 123-45-6789?" });
    const owner = await api.login("owner@rayz.test");
    expect((await api.call("POST", `pay-questions/${q.id}/answer`, { token: owner.accessToken, body: { answer: "Never send 123-45-6789 here." } })).status).toBe(200);
    const row = (await m.db.db.query.payQuestions.findFirst({ where: eq(S().payQuestions.id, q.id) }))!;
    expect(row.detail).not.toMatch(/4242 4242 4242 4242|123-45-6789/);
    expect(JSON.stringify(row.history)).not.toMatch(/4242 4242 4242 4242|123-45-6789/);
    expect(row.history.map((h) => h.kind)).toEqual(["asked", "answered"]);
    expect(row.history[1]).toMatchObject({ by: ids.owner, at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    expect(Number.isNaN(Date.parse(row.history[1].at))).toBe(false);
    await pq.resolvePayQuestion(asker, q.id);
  });

  it("deletes signed-out phones after 30 days and punch photos after 90, keeping photos while a pay question is open", async () => {
    const { staffRetentionCron } = await import("@/server/staff-retention");
    const now = new Date();
    const [old] = await m.db.db.insert(S().staffDevices).values({ staffId: ids.makenna, platform: "ios", provider: "expo", token: "ExponentPushToken[old-phone]", revokedAt: new Date(now.getTime() - 31 * DAY) }).returning();
    const [recent] = await m.db.db.insert(S().staffDevices).values({ staffId: ids.makenna, platform: "ios", provider: "expo", token: "ExponentPushToken[recent-phone]", revokedAt: new Date(now.getTime() - 5 * DAY) }).returning();
    const punchFor = async (staffId: string) =>
      (
        await m.db.db
          .insert(S().timePunches)
          .values({ staffId, shopId: ids.coralville, type: "in", at: new Date(now.getTime() - 100 * DAY), originalAt: new Date(now.getTime() - 100 * DAY), source: "self", method: "qr", hasPhoto: true })
          .returning()
      )[0];
    const mine = await punchFor(ids.makenna);
    const michelle = await punchFor(ids.michelle);
    await m.db.db.insert(S().timePunchPhotos).values([
      { punchId: mine.id, dataUrl: "data:image/jpeg;base64,AAAA", createdAt: new Date(now.getTime() - 100 * DAY) },
      { punchId: michelle.id, dataUrl: "data:image/jpeg;base64,AAAA", createdAt: new Date(now.getTime() - 100 * DAY) },
    ]);
    const open = await pq.askPayQuestion({ staffId: ids.makenna, actor: { staffId: ids.makenna, label: "Makenna" } }, { shopId: ids.coralville, topic: "hours", detail: "Old punch." });

    const r = await staffRetentionCron(now);
    expect(r.devices).toBeGreaterThanOrEqual(1);
    const left = await m.db.db.select({ id: S().staffDevices.id }).from(S().staffDevices).where(m.drizzle.inArray(S().staffDevices.id, [old.id, recent.id]));
    expect(left.map((d) => d.id)).toEqual([recent.id]);
    const photos = await m.db.db.select({ punchId: S().timePunchPhotos.punchId }).from(S().timePunchPhotos).where(m.drizzle.inArray(S().timePunchPhotos.punchId, [mine.id, michelle.id]));
    expect(photos.map((p) => p.punchId)).toEqual([mine.id]);

    await pq.resolvePayQuestion({ staffId: ids.makenna, actor: { staffId: ids.makenna, label: "Makenna" } }, open.id);
    await staffRetentionCron(now);
    expect(await m.db.db.select().from(S().timePunchPhotos).where(eq(S().timePunchPhotos.punchId, mine.id))).toEqual([]);
  });
});
