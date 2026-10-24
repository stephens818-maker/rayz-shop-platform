/**
 * Rayz Assistant without a database: its settings and the per-role switch, the dev stub's router
 * (only tools and reports offered, only names the person can see), help limited to pages the
 * person can open, and what the OpenAI and Anthropic providers send: retention off where the API
 * has a switch, no user identifiers, tools and tool results in each API's shape.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSISTANT, assistantOn, assistantSettings, stubAnswer, stubPlan, suggestions, systemPrompt } from "@/domain/assistant";
import { helpFor } from "@/domain/assistant-help";
import { ROLE_TEMPLATES, effectiveAccess, type Permission } from "@/domain/permissions";

vi.mock("server-only", () => ({}));
const providers = await import("@/server/assistant/providers");

const perms = (key: string) => effectiveAccess(ROLE_TEMPLATES.find((t) => t.key === key)!, {}, null, key === "brand_admin" || key === "brand_owner" ? "all" : "one").permissions as ReadonlySet<Permission>;
const ALL_TOOLS = ["run_report", "customer_report", "help", "draft_po", "draft_blast"];
const opts = { tools: ALL_TOOLS, reports: ["sales_summary", "sales_by_barber", "my_sales", "low_stock", "labor", "lapsed_clients"], shops: ["Ray'z Coralville", "Ray'z Moline"], barbers: ["Makenna R.", "Jamie T."] };

describe("settings", () => {
  it("starts on for every role, and keeps good keys when others are broken", () => {
    expect(assistantSettings(null)).toEqual(DEFAULT_ASSISTANT);
    expect(DEFAULT_ASSISTANT).toMatchObject({ enabled: true, perMinute: 6, perDay: 100, actions: true });
    expect(assistantSettings({ perMinute: 500, perDay: 50, roles: { r1: false } })).toMatchObject({ perMinute: 6, perDay: 50, roles: { r1: false } });
  });

  it("turns off per role, and altogether", () => {
    const s = assistantSettings({ roles: { barber: false } });
    expect(assistantOn(s, "barber")).toBe(false);
    expect(assistantOn(s, "manager")).toBe(true);
    expect(assistantOn({ ...s, enabled: false }, "manager")).toBe(false);
  });
});

describe("the dev stub's router", () => {
  it("compares locations with the sales summary by location", () => {
    expect(stubPlan("Compare sales by location this month", opts)).toEqual({ name: "run_report", args: { report: "sales_summary", preset: "month", locations: ["all"], view: "shops" } });
  });

  it("picks the report, dates, shops and barbers from the question", () => {
    expect(stubPlan("How did Makenna do at Coralville last week?", opts)).toMatchObject({ name: "run_report", args: { report: "sales_summary", preset: "7d", locations: ["Ray'z Coralville"], barbers: ["Makenna R."] } });
    expect(stubPlan("Who were the top barbers yesterday?", opts)).toMatchObject({ args: { report: "sales_by_barber", preset: "yesterday", view: "barbers" } });
    expect(stubPlan("What's running low?", opts)).toMatchObject({ args: { report: "low_stock" } });
    expect(stubPlan("Payroll hours this pay period", opts)).toMatchObject({ args: { report: "labor", preset: "payperiod" } });
  });

  it("only uses reports and tools the person has", () => {
    const barber = { ...opts, tools: ["run_report", "help"], reports: ["my_sales", "service_times"] };
    expect(stubPlan("Compare sales by location", barber)).toMatchObject({ name: "run_report", args: { report: "my_sales" } });
    expect(stubPlan("Draft a purchase order", barber)?.name).not.toBe("draft_po");
    expect(stubPlan("List clients who haven't been back", barber)?.name).not.toBe("customer_report");
    expect(stubPlan("Show me sales", { ...barber, tools: ["help"], reports: [] })).toMatchObject({ name: "help" });
  });

  it("drafts only when asked to, and answers how-to questions with help", () => {
    expect(stubPlan("Draft a PO for Moline", opts)).toEqual({ name: "draft_po", args: { location: "Ray'z Moline" } });
    expect(stubPlan("Write a text blast to clients lapsed 8 weeks", opts)).toMatchObject({ name: "draft_blast", args: { channel: "sms", lastVisitOverDays: 56 } });
    expect(stubPlan("How do I refund a ticket?", opts)).toEqual({ name: "help", args: { question: "How do I refund a ticket?" } });
    expect(stubPlan("List clients who haven't been back in 6 weeks", opts)).toMatchObject({ name: "customer_report", args: { lastVisitOverDays: 42 } });
    expect(stubPlan("Which clients are overdue for a cut?", opts)).toMatchObject({ name: "customer_report", args: { visitStatus: ["overdue"], columns: expect.arrayContaining(["cadence_label", "next_visit_due"]) } });
    expect(stubPlan("Show me clients who are due this week", opts)).toMatchObject({ args: { visitStatus: ["due"] } });
  });

  it("reads back the tools' summary lines", () => {
    expect(stubAnswer([{ name: "run_report", content: "SUMMARY: Sales summary: Net sales $1,000.\nSTATS: ..." }])).toMatch(/^Sales summary: Net sales \$1,000\./);
  });
});

describe("help and suggestions", () => {
  it("only points at pages the person can open", () => {
    expect(helpFor("How do I change someone's permissions?", perms("brand_admin"))[0]?.page).toBe("/admin/permissions");
    expect(helpFor("How do I change someone's permissions?", perms("barber")).map((t) => t.page)).not.toContain("/admin/permissions");
    expect(helpFor("how do I block out lunch", perms("barber"))[0]?.page).toBe("/admin/my-time");
  });

  it("suggests questions from the person's reports", () => {
    expect(suggestions({ reports: ["my_sales"], tools: ["run_report", "help"] })).toEqual(["How were my sales this week?", "How do I block out time for lunch?"]);
  });

  it("tells the model the rules, without drafting rules when there's nothing to draft", () => {
    const p = systemPrompt({ firstName: "Jamie", roleName: "Barber", shopLogin: false, shops: ["Ray'z Coralville"], everyShop: false, today: "Saturday, Oct 24, 2026", tools: ["run_report", "help"] });
    expect(p).toMatch(/Jamie \(Barber\)/);
    expect(p).toMatch(/Answer only from tool results/);
    expect(p).not.toMatch(/draft_po/);
  });
});

describe("providers", () => {
  const tools = [{ name: "run_report", description: "Run a report", parameters: { type: "object", properties: {} } }];
  const messages = [
    { role: "user" as const, content: "Sales?" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "run_report", args: { report: "sales_summary" } }] },
    { role: "tool" as const, callId: "c1", name: "run_report", content: "SUMMARY: $10" },
  ];
  const reply = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));

  it("OpenAI: store off, no user identifier, tools and results in Chat Completions' shape", async () => {
    const f = reply({ choices: [{ message: { content: null, tool_calls: [{ id: "c2", function: { name: "run_report", arguments: '{"report":"kpis"}' } }] } }] });
    const p = providers.openAiProvider("sk-test", "gpt-test", f as unknown as typeof fetch);
    const out = await p.complete({ system: "rules", messages, tools });
    expect(out).toEqual({ text: null, toolCalls: [{ id: "c2", name: "run_report", args: { report: "kpis" } }] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.store).toBe(false);
    expect(body.user).toBeUndefined();
    expect(body.messages[0]).toEqual({ role: "system", content: "rules" });
    expect(body.messages[2].tool_calls[0].function).toEqual({ name: "run_report", arguments: '{"report":"sales_summary"}' });
    expect(body.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "SUMMARY: $10" });
    expect(body.tools[0]).toEqual({ type: "function", function: tools[0] });
  });

  it("Anthropic: the Messages API with tool results as the user's turn", async () => {
    const f = reply({ content: [{ type: "text", text: "Sales were $10." }] });
    const p = providers.anthropicProvider("ak-test", "claude-test", f as unknown as typeof fetch);
    expect(await p.complete({ system: "rules", messages, tools })).toEqual({ text: "Sales were $10.", toolCalls: [] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({ "x-api-key": "ak-test", "anthropic-version": "2023-06-01" });
    const body = JSON.parse(String(init.body));
    expect(body.system).toBe("rules");
    expect(body.metadata).toBeUndefined();
    expect(body.messages[1].content).toEqual([{ type: "tool_use", id: "c1", name: "run_report", input: { report: "sales_summary" } }]);
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "SUMMARY: $10" }] });
    expect(body.tools[0]).toEqual({ name: "run_report", description: "Run a report", input_schema: tools[0].parameters });
  });

  it("turns a provider's refusal into an error without its body", async () => {
    const f = vi.fn(async () => new Response("secret prompt echo", { status: 500 }));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(providers.openAiProvider("k", "m", f as unknown as typeof fetch).complete({ system: "", messages, tools })).rejects.toThrow(/didn't answer/);
    expect(err.mock.calls.flat().join(" ")).not.toContain("secret prompt echo");
    err.mockRestore();
  });

  it("picks the provider from the environment, and runs the stub only outside production", () => {
    expect(providers.assistantProvider({ OPENAI_API_KEY: "k" })?.id).toBe("openai");
    expect(providers.assistantProvider({ ANTHROPIC_API_KEY: "k", ASSISTANT_MODEL: "claude-x" })).toMatchObject({ id: "anthropic", model: "claude-x" });
    expect(providers.assistantProvider({ ASSISTANT_PROVIDER: "anthropic", OPENAI_API_KEY: "k" })).toBeNull();
    expect(providers.assistantProvider({ NODE_ENV: "development" })?.id).toBe("stub");
    expect(providers.assistantProvider({ NODE_ENV: "production" })).toBeNull();
    expect(providers.assistantProvider({ NODE_ENV: "production", ASSISTANT_PROVIDER: "stub" })?.id).toBe("stub");
    expect(providers.assistantProvider({ ASSISTANT_PROVIDER: "off", OPENAI_API_KEY: "k" })).toBeNull();
    expect(JSON.stringify(providers.providerStatus({ OPENAI_API_KEY: "sk-secret" }))).not.toContain("sk-secret");
  });
});
