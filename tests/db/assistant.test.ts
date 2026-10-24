/**
 * Rayz Assistant against the seeded brand, with a scripted provider that records everything the
 * model would be sent: each person's tools and reports are only what they may open, names resolve
 * only inside their locations and barbers, Client data's hidden fields and client contact details
 * never reach the model, drafts wait for the person's confirmation and their permissions then,
 * every question and tool call is audited, and the per-role switch and the limits hold.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Mods, loadModules } from "./setup";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", async () => (await import("./session")).headersMock);
vi.mock("next/cache", () => ({ revalidatePath() {}, revalidateTag() {} }));

let m: Mods;
let assistant: typeof import("@/server/assistant");
let tools: typeof import("@/server/assistant/tools");
let providers: typeof import("@/server/assistant/providers");
let context: typeof import("@/server/report-builder/context");
type Ctx = import("@/server/auth/staff").StaffContext;
type Request = import("@/server/assistant/providers").CompletionRequest;
type Provider = import("@/server/assistant/providers").Provider;
const ids: Record<string, string> = {};
const shop: Record<string, string> = {};
const roleId: Record<string, string> = {};

const sql = (...a: Parameters<Mods["drizzle"]["sql"]>) => m.drizzle.sql(...a);
const rows = async <T>(q: ReturnType<typeof sql>) => (await m.db.db.execute(q)) as unknown as T[];
const ctxOf = async (who: string) => (await context.staffContextFor(ids[who]))!;
const without = (c: Ctx, perms: string[]): Ctx => ({ ...c, permissions: new Set([...c.permissions].filter((p) => !perms.includes(p))) as Ctx["permissions"] });

/** Calls these tools, one round each, then answers "done"; keeps every request it was sent. */
function scripted(...rounds: { name: string; args: Record<string, unknown> }[][]): Provider & { seen: Request[] } {
  const seen: Request[] = [];
  let i = 0;
  return {
    id: "openai",
    model: "test",
    retention: "test",
    seen,
    async complete(r) {
      seen.push(structuredClone(r));
      const calls = rounds[i++];
      return calls ? { text: null, toolCalls: calls.map((c, j) => ({ id: `c${i}-${j}`, ...c })) } : { text: "done", toolCalls: [] };
    },
  };
}
const sentToModel = (p: { seen: Request[] }) => JSON.stringify(p.seen);
const toolResults = (p: { seen: Request[] }) => p.seen[p.seen.length - 1].messages.filter((x) => x.role === "tool").map((x) => (x as { content: string }).content);
const setSettings = (s: Record<string, unknown>) => m.db.db.update(m.schema.brandSettings).set({ assistant: s });

beforeAll(async () => {
  m = await loadModules();
  assistant = await import("@/server/assistant");
  tools = await import("@/server/assistant/tools");
  providers = await import("@/server/assistant/providers");
  context = await import("@/server/report-builder/context");
  for (const k of ["owner", "admin", "regional", "michelle", "makenna", "frontdesk", "manager.moline", "coralville"])
    ids[k] = (await m.db.db.query.staff.findFirst({ where: m.drizzle.eq(m.schema.staff.email, `${k}@rayz.test`) }))!.id;
  for (const s of await m.db.db.select().from(m.schema.shops)) shop[s.slug] = s.id;
  for (const r of await m.db.db.select().from(m.schema.roles)) if (r.key) roleId[r.key] = r.id;
}, 180_000);

beforeEach(async () => {
  await setSettings({ perMinute: 30, perDay: 1000 });
});

afterAll(async () => {
  await m.db.db.delete(m.schema.assistantConversations);
  await m.db.db.delete(m.schema.clientFieldRules).where(m.drizzle.eq(m.schema.clientFieldRules.field, "preferred_barber"));
  await setSettings({});
  await m.db.closeDb();
});

describe("tools follow the person's permissions", () => {
  it("offers a barber only their own reports and client notes, no client lists and no drafts", async () => {
    const makenna = await ctxOf("makenna");
    const set = await tools.toolsFor(makenna, (await assistant.loadAssistantSettings()));
    expect(set.map((t) => t.name).sort()).toEqual(["client_notes", "help", "run_report"]);
    const reportEnum = (set[0].spec.parameters as { properties: { report: { enum: string[] } } }).properties.report.enum;
    expect(reportEnum.sort()).toEqual(["my_sales", "service_times"]);
  });

  it("offers a manager client lists and purchase orders but not blasts, and the brand admin everything", async () => {
    const s = await assistant.loadAssistantSettings();
    expect((await tools.toolsFor(await ctxOf("michelle"), s)).map((t) => t.name).sort()).toEqual(["client_notes", "customer_report", "draft_po", "help", "run_report"]);
    expect((await tools.toolsFor(await ctxOf("admin"), s)).map((t) => t.name).sort()).toEqual(["client_notes", "customer_report", "draft_blast", "draft_po", "help", "run_report"]);
    expect((await tools.toolsFor(await ctxOf("admin"), { ...s, actions: false })).map((t) => t.name).sort()).toEqual(["client_notes", "customer_report", "help", "run_report"]);
  });

  it("never offers the audit log, client ratings or reports the person can't view", async () => {
    const admin = await ctxOf("admin");
    const [run] = await tools.toolsFor(admin, await assistant.loadAssistantSettings());
    const reportEnum = (run.spec.parameters as { properties: { report: { enum: string[] } } }).properties.report.enum;
    expect(reportEnum).not.toContain("audit_log");
    expect(reportEnum).not.toContain("client_ratings");
    const limited = without(admin, ["report.sales_summary.view"]);
    const [run2] = await tools.toolsFor(limited, await assistant.loadAssistantSettings());
    expect((run2.spec.parameters as { properties: { report: { enum: string[] } } }).properties.report.enum).not.toContain("sales_summary");
    const p = scripted([{ name: "run_report", args: { report: "sales_summary" } }]);
    await assistant.askAssistant(limited, { question: "sales?" }, { provider: p });
    expect(toolResults(p)[0]).toMatch(/arguments didn't fit/);
  });
});

describe("location and barber scope", () => {
  it("keeps a shop manager to their shop: another location is refused, and \"all\" means all of theirs", async () => {
    const michelle = await ctxOf("michelle");
    const p = scripted([{ name: "run_report", args: { report: "sales_summary", locations: ["Moline"] } }], [{ name: "run_report", args: { report: "sales_summary", locations: ["all"], view: "shops" } }]);
    const r = await assistant.askAssistant(michelle, { question: "Compare Moline and Coralville sales" }, { provider: p });
    const [refused, all] = toolResults(p);
    expect(refused).toMatch(/"Moline" isn't one of your locations/);
    expect(all).toMatch(/Coralville/);
    expect(all).not.toMatch(/Moline|Kimberly|Silvis|Utica|Dubuque/);
    const card = r.messages[1].cards[0];
    expect(card.kind).toBe("report");
    expect(card.kind === "report" && card.subtitle).toMatch(/Coralville/);
    expect(card.links[0].href).toMatch(/^\/admin\/reports\/sales\?/);
    const [audit] = await rows<{ ok: string; error: string }>(sql`select details->>'ok' ok, details->>'error' error from audit_log where action = 'assistant.tool' and actor_staff_id = ${ids.michelle} order by at limit 1`);
    expect(audit).toEqual({ ok: "false", error: expect.stringMatching(/isn't one of your locations/) });
  });

  it("names only barbers at the person's locations, and a barber always gets their own numbers", async () => {
    const michelle = await ctxOf("michelle");
    const p = scripted([{ name: "run_report", args: { report: "sales_by_barber", barbers: ["Kat"] } }]);
    await assistant.askAssistant(michelle, { question: "How did Kat do?" }, { provider: p });
    expect(toolResults(p)[0]).toMatch(/"Kat" isn't a barber at your locations/);

    const makenna = await ctxOf("makenna");
    const q = scripted([{ name: "run_report", args: { report: "my_sales", barbers: ["Michelle"] } }]);
    const r = await assistant.askAssistant(makenna, { question: "Michelle's sales?" }, { provider: q });
    expect(toolResults(q)[0]).toMatch(/only see their own numbers/);
    const card = r.messages[1].cards[0];
    expect(card.kind === "report" && card.subtitle).toMatch(/Makenna/);
  });

  it("runs a shop login's questions at its one shop", async () => {
    const login = await ctxOf("coralville");
    expect(login.staff.kind).toBe("shop");
    const set = await tools.toolsFor(login, await assistant.loadAssistantSettings());
    const runReport = set.find((t) => t.name === "run_report");
    if (!runReport) return;
    const report = (runReport.spec.parameters as { properties: { report: { enum: string[] } } }).properties.report.enum[0];
    const p = scripted([{ name: "run_report", args: { report, locations: ["all"] } }]);
    await assistant.askAssistant(login, { question: "today?" }, { provider: p });
    expect(toolResults(p)[0]).not.toMatch(/Moline|Kimberly|Silvis|Utica|Dubuque/);
  });
});

describe("what reaches the model", () => {
  it("never includes a client's phone, email, address, birthday or notes, even for the owner", async () => {
    const owner = await ctxOf("owner");
    const p = scripted(
      [
        { name: "customer_report", args: { columns: ["name", "home_location", "last_visit", "visits", "total_spend"], locations: ["all"] } },
        { name: "run_report", args: { report: "lapsed_clients", locations: ["all"] } },
        { name: "run_report", args: { report: "sales_summary", locations: ["all"] } },
      ],
      [{ name: "customer_report", args: { columns: ["name", "phone", "email"] } }],
    );
    await assistant.askAssistant(owner, { question: "Who are my best clients?" }, { provider: p });
    const sent = sentToModel(p);
    const secrets = await rows<{ phone: string | null; email: string | null; address: string | null; birthday: string | null; notes: string | null }>(
      sql`select phone, email, address, birthday::text birthday, notes from customers where phone is not null or email is not null limit 200`,
    );
    expect(secrets.length).toBeGreaterThan(5);
    for (const s of secrets) for (const v of [s.phone, s.email, s.address, s.notes]) if (v && v.length > 5) expect(sent.includes(v), v).toBe(false);
    expect(toolResults(p)[3]).toMatch(/arguments didn't fit/);
    const fields = JSON.stringify(p.seen[0].tools.find((t) => t.name === "customer_report")!.parameters);
    for (const f of ["\"phone\"", "\"email\"", "\"address\"", "\"birthday\""]) expect(fields).not.toContain(f);
  });

  it("leaves out a field Client data hides from the person", async () => {
    await m.db.db.insert(m.schema.clientFieldRules).values({ field: "preferred_barber", setting: "view", level: "hidden", roleId: roleId.shop_manager });
    const michelle = await ctxOf("michelle");
    const set = await tools.toolsFor(michelle, await assistant.loadAssistantSettings());
    const fields = JSON.stringify(set.find((t) => t.name === "customer_report")!.spec);
    expect(fields).not.toContain("primary_barber");
    const p = scripted([{ name: "customer_report", args: { columns: ["name", "primary_barber"] } }]);
    await assistant.askAssistant(michelle, { question: "clients by barber" }, { provider: p });
    expect(toolResults(p)[0]).toMatch(/arguments didn't fit/);
    expect(JSON.stringify(p.seen.map((r) => [r.system, r.tools]))).not.toMatch(/primary_barber|Primary barber/);
    await m.db.db.delete(m.schema.clientFieldRules).where(m.drizzle.eq(m.schema.clientFieldRules.field, "preferred_barber"));
  });

  it("scrubs card numbers out of the question before the model, the database or the audit log sees them", async () => {
    const admin = await ctxOf("admin");
    const p = scripted();
    const r = await assistant.askAssistant(admin, { question: "Refund card 4242424242424242 please" }, { provider: p });
    expect(sentToModel(p)).not.toContain("4242424242424242");
    expect(r.messages[0].body).not.toContain("4242424242424242");
    const found = await rows<{ n: number }>(sql`select count(*)::int n from audit_log where details::text like '%4242424242424242%'`);
    expect(found[0].n).toBe(0);
  });

  it("tells the model who's asking and where, with no ids", async () => {
    const michelle = await ctxOf("michelle");
    const p = scripted();
    await assistant.askAssistant(michelle, { question: "hi" }, { provider: p });
    expect(p.seen[0].system).toMatch(/Michelle \(Shop Manager\)/);
    expect(p.seen[0].system).toMatch(/Coralville/);
    expect(p.seen[0].system).not.toContain(ids.michelle);
    expect(p.seen[0].system).not.toContain(shop.coralville);
  });
});

describe("drafts wait for confirmation", () => {
  it("drafts purchase orders without creating any, and creates them only when the person confirms", async () => {
    const michelle = await ctxOf("michelle");
    const before = await rows<{ n: number }>(sql`select count(*)::int n from purchase_orders where shop_id = ${shop.coralville}`);
    const p = scripted([{ name: "draft_po", args: {} }]);
    const r = await assistant.askAssistant(michelle, { question: "Draft a PO for what's low" }, { provider: p });
    const card = r.messages[1].cards[0];
    expect(card.kind).toBe("action");
    if (card.kind !== "action") return;
    expect(card.status).toBe("pending");
    expect((await rows<{ n: number }>(sql`select count(*)::int n from purchase_orders where shop_id = ${shop.coralville}`))[0].n).toBe(before[0].n);

    await expect(assistant.decideAssistantAction(await ctxOf("admin"), card.actionId, true)).rejects.toThrow(/not found/);
    const done = await assistant.decideAssistantAction(michelle, card.actionId, true);
    expect(done.status).toBe("confirmed");
    expect(done.links[0].href).toMatch(/^\/admin\/purchase-orders\//);
    expect((await rows<{ n: number }>(sql`select count(*)::int n from purchase_orders where shop_id = ${shop.coralville}`))[0].n).toBeGreaterThan(before[0].n);
    await expect(assistant.decideAssistantAction(michelle, card.actionId, true)).rejects.toThrow(/already done/);
    const [a] = await rows<{ n: number }>(sql`select count(*)::int n from audit_log where action = 'assistant.action_confirmed' and actor_staff_id = ${ids.michelle}`);
    expect(a.n).toBe(1);
  });

  it("checks the permission again on confirm, and a cancelled draft can't be confirmed", async () => {
    const regional = await ctxOf("regional");
    const p = scripted([{ name: "draft_po", args: { location: "Moline" } }], [{ name: "draft_po", args: { location: "Rock Island" } }]);
    const r = await assistant.askAssistant(regional, { question: "Draft POs" }, { provider: p });
    const [one, two] = r.messages[1].cards;
    if (one?.kind !== "action" || two?.kind !== "action") throw new Error("expected two drafts");
    await expect(assistant.decideAssistantAction(without(regional, ["po.create"]), one.actionId, true)).rejects.toThrow(/Create and edit purchase orders/);
    const [st] = await rows<{ status: string }>(sql`select status from assistant_actions where id = ${one.actionId}`);
    expect(st.status).toBe("failed");
    expect((await assistant.decideAssistantAction(regional, two.actionId, false)).status).toBe("cancelled");
    await expect(assistant.decideAssistantAction(regional, two.actionId, true)).rejects.toThrow(/cancelled/);
  });

  it("saves a confirmed blast as a draft and never sends it", async () => {
    const admin = await ctxOf("admin");
    const p = scripted([{ name: "draft_blast", args: { name: "Assistant test blast", channel: "sms", message: "Hi {first_name}, come back to {shop}: {book_link}", lastVisitOverDays: 42 } }]);
    const r = await assistant.askAssistant(admin, { question: "Draft a win-back text" }, { provider: p });
    const card = r.messages[1].cards[0];
    if (card?.kind !== "action") throw new Error("expected a draft");
    expect(card.lines.join(" ")).toMatch(/Reply STOP to opt out/);
    expect((await rows<{ n: number }>(sql`select count(*)::int n from marketing_campaigns where name = 'Assistant test blast'`))[0].n).toBe(0);
    const done = await assistant.decideAssistantAction(admin, card.actionId, true);
    const [blast] = await rows<{ status: string; segment: { lastVisitOverDays: number } }>(sql`select status, segment from marketing_campaigns where name = 'Assistant test blast'`);
    expect(blast.status).toBe("draft");
    expect(blast.segment.lastVisitOverDays).toBe(42);
    expect(done.links[0].href).toMatch(/^\/admin\/campaign-center\/blasts\//);
    await m.db.db.execute(sql`delete from marketing_campaigns where name = 'Assistant test blast'`);
  });
});

describe("access, audit and limits", () => {
  it("audits every question and tool call", async () => {
    const frontdesk = await ctxOf("frontdesk");
    const p = scripted([{ name: "help", args: { question: "How do I check out a client?" } }]);
    const r = await assistant.askAssistant(frontdesk, { question: "How do I check out a client?" }, { provider: p });
    const logged = await rows<{ action: string; details: Record<string, unknown> }>(sql`select action, details from audit_log where actor_staff_id = ${ids.frontdesk} and entity_id = ${r.conversationId} order by at`);
    expect(logged.map((l) => l.action)).toEqual(["assistant.question", "assistant.tool"]);
    expect(logged[0].details.question).toBe("How do I check out a client?");
    expect(logged[1].details).toMatchObject({ tool: "help", ok: true });
    expect(r.messages[1].cards[0]).toMatchObject({ kind: "help", title: "Check out a client" });
  });

  it("only gives help about pages the person can open", async () => {
    const makenna = await ctxOf("makenna");
    const p = scripted([{ name: "help", args: { question: "How do I change someone's permissions?" } }]);
    await assistant.askAssistant(makenna, { question: "permissions?" }, { provider: p });
    expect(toolResults(p)[0]).not.toMatch(/Permissions and pick the role/);
  });

  it("turns off per role and altogether", async () => {
    const michelle = await ctxOf("michelle");
    await setSettings({ roles: { [roleId.shop_manager]: false } });
    expect((await assistant.assistantAccess(michelle, providers.stubProvider())).on).toBe(false);
    await expect(assistant.askAssistant(michelle, { question: "sales?" }, { provider: scripted() })).rejects.toThrow(/turned off for your role/);
    expect((await assistant.assistantAccess(await ctxOf("admin"), providers.stubProvider())).on).toBe(true);
    await setSettings({ enabled: false });
    expect((await assistant.assistantAccess(await ctxOf("admin"), providers.stubProvider())).on).toBe(false);
    expect((await assistant.assistantAccess(await ctxOf("admin"), null)).on).toBe(false);
  });

  it("limits questions per minute and per day, and logs the refusal", async () => {
    await setSettings({ perMinute: 2, perDay: 1000 });
    const mgr = await ctxOf("manager.moline");
    await assistant.askAssistant(mgr, { question: "one" }, { provider: scripted() });
    await assistant.askAssistant(mgr, { question: "two" }, { provider: scripted() });
    await expect(assistant.askAssistant(mgr, { question: "three" }, { provider: scripted() })).rejects.toMatchObject({ code: "rate_limited" });
    const [x] = await rows<{ n: number }>(sql`select count(*)::int n from audit_log where action = 'assistant.rate_limited' and actor_staff_id = ${ids["manager.moline"]}`);
    expect(x.n).toBe(1);
    await m.db.db.execute(sql`update assistant_messages set created_at = created_at - interval '2 minutes' where staff_id = ${ids["manager.moline"]}`);
    await setSettings({ perMinute: 30, perDay: 5 });
    for (const q of ["three", "four", "five"]) await assistant.askAssistant(mgr, { question: q }, { provider: scripted() });
    await expect(assistant.askAssistant(mgr, { question: "six" }, { provider: scripted() })).rejects.toThrow(/daily limit/);
  });

  it("keeps each person's conversations to themselves", async () => {
    const michelle = await ctxOf("michelle");
    const r = await assistant.askAssistant(michelle, { question: "mine" }, { provider: scripted() });
    const admin = await ctxOf("admin");
    await expect(assistant.askAssistant(admin, { conversationId: r.conversationId, question: "theirs?" }, { provider: scripted() })).rejects.toThrow(/not found/);
    await expect(assistant.assistantConversation(admin, r.conversationId)).rejects.toThrow(/not found/);
    expect((await assistant.assistantConversation(michelle, r.conversationId))!.messages.map((x) => x.body)).toEqual(["mine", "done"]);
  });
});

describe("the dev stub", () => {
  it("answers a comparison question with the report and a link to it", async () => {
    const admin = await ctxOf("admin");
    const r = await assistant.askAssistant(admin, { question: "Compare sales by location this month" }, { provider: providers.stubProvider() });
    const card = r.messages[1].cards[0];
    expect(card?.kind).toBe("report");
    if (card?.kind !== "report") return;
    expect(card.title).toBe("Sales summary");
    expect(card.links[0].href).toContain("preset=month");
    expect(card.links[0].href).toContain("view=shops");
    expect(r.messages[1].body).toMatch(/Sales summary/);
    expect(card.table!.rows[0].some((v) => /^\$[\d,]+\.\d\d$/.test(v))).toBe(true);
  });

  it("refuses a location outside the person's scope instead of quietly answering for their own", async () => {
    const michelle = await ctxOf("michelle");
    const r = await assistant.askAssistant(michelle, { question: "Compare Moline and Coralville sales this week" }, { provider: providers.stubProvider() });
    expect(r.messages[1].cards).toEqual([]);
    expect(r.messages[1].body).toMatch(/isn't one of your locations/);
  });

  it("turns a client list into a builder link and a blast segment", async () => {
    const admin = await ctxOf("admin");
    const r = await assistant.askAssistant(admin, { question: "List clients who haven't been back in 8 weeks" }, { provider: providers.stubProvider() });
    const card = r.messages[1].cards[0];
    if (card?.kind !== "report") throw new Error("expected a report card");
    expect(card.links.map((l) => l.href.split("?")[0])).toEqual(["/admin/reports/custom/new", "/admin/campaign-center/blasts/new"]);
    const d = new URL(card.links[0].href, "http://x").searchParams.get("d")!;
    const def = (await import("@/domain/report-builder")).decodeDefinition(d);
    expect(def?.filter.lastVisitOverDays).toBe(56);
  });
});
