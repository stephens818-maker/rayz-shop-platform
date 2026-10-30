/**
 * The phone agent's call log: transcripts of what the agent said and what the caller pressed or said
 * (with speech on), outcomes including a booking that followed, the follow-up on a missed call, the
 * transcripts-off setting, card numbers scrubbed from what callers say, and the page itself.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Mods, actor, loadModules } from "./setup";
import { signInAs } from "./session";
import { open } from "./render";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let line: typeof import("@/server/shop-line");
let agent: typeof import("@/server/phone-agent");
let settings: typeof import("@/app/admin/settings/actions");
let shop: { id: string; twilioNumber: string | null };
let other: string;
let mon: string;
let seq = 0;
const eq = (...a: Parameters<Mods["drizzle"]["eq"]>) => m.drizzle.eq(...a);
const ok = <T>(r: { ok: true; data: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};
const at = (min: number) => m.time.zonedWallTime(mon, min).toJSDate();
const brand = () => ({ brandWide: true, shopIds: [shop.id, other] });
const sid = () => `CA-agent-${++seq}-${crypto.randomUUID().slice(0, 6)}`;
const caller = () => `+1319556${String(1000 + Math.floor(Math.random() * 8999)).slice(-4)}`;
const callOf = async (callSid: string) => (await m.db.db.query.callLogs.findFirst({ where: eq(m.schema.callLogs.providerCallId, callSid) }))!;
const operator = (o: Partial<{ enabled: boolean; answer: "fallback" | "first"; speech: boolean; transcripts: boolean }> = {}) =>
  settings.savePhoneOperatorAction(shop.id, { enabled: true, answer: "fallback", minutesPerCall: 3, greeting: "", speech: false, transcripts: true, ...o });

beforeAll(async () => {
  m = await loadModules();
  line = await import("@/server/shop-line");
  agent = await import("@/server/phone-agent");
  settings = await import("@/app/admin/settings/actions");
  shop = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "kimberly") }))!;
  other = (await m.db.db.query.shops.findFirst({ where: eq(m.schema.shops.slug, "moline") }))!.id;
  mon = m.time.addDays(m.time.todayLocal(), -6);
  while (m.time.weekdayOf(mon) !== 1) mon = m.time.addDays(mon, 1);
  const owner = (await m.db.db.query.staff.findFirst({ where: eq(m.schema.staff.email, "owner@rayz.test") }))!;
  await signInAs(owner.id);
}, 120_000);

afterAll(async () => {
  if (shop) await m.db.db.update(m.schema.shops).set({ phoneOperator: {} }).where(eq(m.schema.shops.id, shop.id));
  await m?.db.closeDb();
});

describe("phone agent", () => {
  it("with speech on, understands 'book', texts the link, and keeps the whole call as a transcript", async () => {
    ok(await operator({ speech: true }));
    const callSid = sid();
    const menu = await line.handleIncomingCall({ from: caller(), to: shop.twilioNumber!, callSid }, at(22 * 60));
    expect(menu).toContain('input="dtmf speech"');
    expect(menu).toContain("say book");
    const sorry = await line.handleOperatorChoice({ callSid, digits: "", speech: "uh what is this" }, at(22 * 60 + 1));
    expect(sorry).toContain("Sorry, I didn&apos;t catch that.");
    expect((await callOf(callSid)).digits).toBeNull();
    const done = await line.handleOperatorChoice({ callSid, digits: "", speech: "I'd like to book a haircut" }, at(22 * 60 + 2));
    expect(done).toContain("texted you a link to book");
    const call = await callOf(callSid);
    expect([call.operatorChoice, call.autoTextSent]).toEqual(["book", true]);

    const d = (await agent.phoneAgentCall(brand(), call.id))!;
    expect(d.outcome).toBe("link_texted");
    expect(d.lines.map((l) => l.speaker)).toEqual(["line", "agent", "caller", "agent", "caller", "line", "agent"]);
    expect(d.lines[2].text).toBe("“uh what is this”");
    expect(d.lines[3].text).toMatch(/^Sorry, I didn't catch that/);
    expect(d.lines[5].text).toBe("Texted the booking link.");
    expect(d.texts).toHaveLength(1);
    expect(await agent.phoneAgentCall({ brandWide: false, shopIds: [other] }, call.id)).toBeNull();
  });

  it("scrubs a card number a caller reads out", async () => {
    ok(await operator({ speech: true }));
    const callSid = sid();
    await line.handleIncomingCall({ from: caller(), to: shop.twilioNumber!, callSid }, at(22 * 60 + 5));
    await line.handleOperatorChoice({ callSid, digits: "", speech: "my card is 4242 4242 4242 4242 can I book" }, at(22 * 60 + 6));
    const d = (await agent.phoneAgentCall(brand(), (await callOf(callSid)).id))!;
    const said = d.lines.find((l) => l.speaker === "caller")!.text;
    expect(said).not.toContain("4242 4242 4242 4242");
  });

  it("keeps outcomes only when transcripts are off", async () => {
    ok(await operator({ transcripts: false }));
    const callSid = sid();
    await line.handleIncomingCall({ from: caller(), to: shop.twilioNumber!, callSid }, at(22 * 60 + 10));
    await line.handleOperatorChoice({ callSid, digits: "2" }, at(22 * 60 + 11));
    await line.handleOperatorChoice({ callSid, digits: "", none: true }, at(22 * 60 + 12));
    const d = (await agent.phoneAgentCall(brand(), (await callOf(callSid)).id))!;
    expect(d.lines).toEqual([]);
    expect(d.outcome).toBe("link_texted");
  });

  it("counts a booking that followed, and lists calls by outcome", async () => {
    ok(await operator());
    const phone = caller();
    const callSid = sid();
    await line.handleIncomingCall({ from: phone, to: shop.twilioNumber!, callSid }, at(22 * 60 + 20));
    await line.handleOperatorChoice({ callSid, digits: "1" }, at(22 * 60 + 21));
    const [c] = await m.db.db.insert(m.schema.customers).values({ firstName: "Caller", lastName: `Agent${seq}`, phone, homeShopId: shop.id }).returning();
    const barber = (await m.db.db.select({ id: m.schema.staffShops.staffId }).from(m.schema.staffShops).where(eq(m.schema.staffShops.shopId, shop.id)).limit(1))[0].id;
    // Before opening, so it can't land on a seeded booking when this week's Monday is today.
    const startsAt = m.time.zonedWallTime(m.time.addDays(mon, 2), 5 * 60).toJSDate();
    await m.db.db.insert(m.schema.appointments).values({
      code: `P${crypto.randomUUID().replace(/-/g, "").slice(0, 9).toUpperCase()}`,
      shopId: shop.id,
      staffId: barber,
      customerId: c.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: "booked",
      source: "online",
      estimateCents: 3300,
      createdAt: at(22 * 60 + 30),
    });
    const r = await agent.phoneAgentCalls({ shopIds: [shop.id], start: at(0), end: at(24 * 60), filter: "booked" });
    const row = r.calls.find((x) => x.phone === `***-***-${phone.slice(-4)}`)!;
    expect([row.outcome, row.bookedCents]).toEqual(["booked", 3300]);
    expect(r.counts.booked).toBeGreaterThanOrEqual(1);
    expect(r.calls.every((x) => x.outcome === "booked")).toBe(true);
  });

  it("flags a missed call for a follow-up, records who followed up, and keeps other shops out", async () => {
    ok(await operator({ enabled: false }));
    const callSid = sid();
    const ring = await line.handleIncomingCall({ from: caller(), to: shop.twilioNumber!, callSid }, at(12 * 60));
    expect(ring).toContain("<Dial");
    await line.handleDialResult({ callSid, dialStatus: "no-answer" }, at(12 * 60 + 1));
    const call = await callOf(callSid);
    const before = (await agent.phoneAgentCall(brand(), call.id))!;
    expect([before.outcome, before.followUp]).toEqual(["missed", true]);
    expect(before.lines.map((l) => l.text)).toEqual(expect.arrayContaining(["Rang the shop phone.", "Nobody at the shop picked up."]));
    const list = await agent.phoneAgentCalls({ shopIds: [shop.id], start: at(0), end: at(24 * 60), filter: "follow_up" });
    expect(list.calls.some((x) => x.id === call.id)).toBe(true);

    await expect(agent.markFollowedUp(actor, { brandWide: false, shopIds: [other] }, { id: call.id, note: "x" })).rejects.toThrow(/outside your access/);
    await agent.markFollowedUp(actor, brand(), { id: call.id, note: "Rang back, booked Friday" });
    await expect(agent.markFollowedUp(actor, brand(), { id: call.id })).rejects.toThrow(/already followed up/);
    const after = (await agent.phoneAgentCall(brand(), call.id))!;
    expect([after.followUp, after.followUpNote]).toEqual([false, "Rang back, booked Friday"]);
    const log = await m.db.db.select().from(m.schema.auditLog).where(eq(m.schema.auditLog.entityId, call.id));
    expect(log.map((l) => l.action)).toContain("call.follow_up");
    await agent.markFollowedUp(actor, brand(), { id: call.id, undo: true });
    expect((await agent.phoneAgentCall(brand(), call.id))!.followUp).toBe(true);
  });

  it("shows the call log, a transcript and the settings on the page", async () => {
    ok(await operator({ speech: true }));
    const callSid = sid();
    await line.handleIncomingCall({ from: caller(), to: shop.twilioNumber!, callSid }, at(22 * 60 + 40));
    await line.handleOperatorChoice({ callSid, digits: "", speech: "what are your hours" }, at(22 * 60 + 41));
    const call = await callOf(callSid);
    const editors: Record<string, unknown>[] = [];
    const page = await open("/admin/phone-agent", {}, { shop: shop.id, days: "7", call: call.id }, (_t, props) => {
      if ("initial" in props && "hasLine" in props) editors.push(props);
    });
    expect(page.kind).toBe("ok");
    if (page.kind !== "ok") return;
    expect(page.text).toContain("Call log");
    expect(page.text).toContain("Transcript");
    expect(page.text).toContain("“what are your hours”");
    expect(page.text).toContain("Heard the hours");
    expect(editors).toMatchObject([{ shopId: shop.id, hasLine: true, initial: { enabled: true, speech: true, transcripts: true } }]);
    const all = await open("/admin/phone-agent");
    expect(all.kind === "ok" && all.text).toContain("Shop (all)");
  });
});
