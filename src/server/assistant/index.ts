import "server-only";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { assistantActions, assistantConversations, assistantMessages, brandSettings, shops } from "@/db/schema";
import {
  ACTION_TTL_MS,
  ASSISTANT_REPORTS,
  AssistantSettingsSchema,
  HISTORY_MESSAGES,
  MAX_ROUNDS,
  MAX_TOOL_CALLS,
  QUESTION_MAX,
  assistantOn,
  assistantSettings,
  suggestions,
  systemPrompt,
  type AssistantCard,
  type AssistantMessageView,
  type AssistantSettings,
} from "@/domain/assistant";
import { reportView } from "@/domain/permissions";
import { scrub, scrubText } from "@/lib/sensitive";
import { formatDate, todayLocal } from "@/lib/time";
import { audit, type Actor } from "../audit";
import { can, type StaffContext } from "../auth/staff";
import { barbersAt } from "../barbers";
import { AppError, forbidden, notFound } from "../errors";
import { whoOf } from "../inventory/ledger";
import { createPos } from "../inventory/purchasing";
import { saveBlast } from "../marketing/campaigns";
import { assistantProvider, type ChatMessage, type Provider, type ToolCall } from "./providers";
import { toolsFor } from "./tools";

export async function loadAssistantSettings(): Promise<AssistantSettings> {
  const [b] = await db.select({ a: brandSettings.assistant }).from(brandSettings).limit(1);
  return assistantSettings(b?.a);
}

export async function saveAssistantSettings(ctx: StaffContext, raw: unknown) {
  if (!can(ctx, "assistant.settings")) throw forbidden("You can't change Rayz Assistant's settings");
  const parsed = AssistantSettingsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError("bad_request", parsed.error.issues[0]?.message ?? "Check the assistant settings");
  await db.update(brandSettings).set({ assistant: parsed.data, updatedAt: new Date() });
  await audit(ctx.actor, "settings.assistant", "brand_settings", "assistant", parsed.data, null);
  return parsed.data;
}

/** Whether this person gets the assistant right now: it's on for the role they're working under, and a provider is set up. */
export async function assistantAccess(ctx: StaffContext, provider: Provider | null = assistantProvider()) {
  const settings = await loadAssistantSettings();
  const on = !!provider && assistantOn(settings, ctx.staff.roleId);
  return { on, settings, provider };
}

async function assertAccess(ctx: StaffContext, provider?: Provider | null) {
  const a = await assistantAccess(ctx, provider === undefined ? assistantProvider() : provider);
  if (!a.provider) throw new AppError("bad_request", "Rayz Assistant isn't set up on this server yet");
  if (!a.on) throw forbidden("Rayz Assistant is turned off for your role");
  return { settings: a.settings, provider: a.provider };
}

/** Questions per person per minute and per day, counted from what they asked. */
async function assertUnderLimit(ctx: StaffContext, s: AssistantSettings, now: Date) {
  const since = async (ms: number) =>
    (
      await db
        .select({ n: count() })
        .from(assistantMessages)
        .where(and(eq(assistantMessages.staffId, ctx.staff.id), eq(assistantMessages.role, "user"), gte(assistantMessages.createdAt, new Date(now.getTime() - ms))))
    )[0].n;
  const [minute, day] = await Promise.all([since(60_000), since(24 * 60 * 60_000)]);
  const over = minute >= s.perMinute ? "minute" : day >= s.perDay ? "day" : null;
  if (!over) return;
  await audit(ctx.actor, "assistant.rate_limited", "staff", ctx.staff.id, { per: over, limit: over === "minute" ? s.perMinute : s.perDay }, ctx.currentShopId);
  throw new AppError("rate_limited", over === "minute" ? "That's a lot of questions in a minute. Wait a moment and ask again." : `You've asked ${s.perDay} questions today, the brand's daily limit. It resets tomorrow.`);
}

const view = (m: typeof assistantMessages.$inferSelect): AssistantMessageView => ({ id: m.id, role: m.role, body: m.body, cards: m.cards as AssistantCard[], at: m.createdAt.toISOString() });

/** The person's conversation (the latest when no id), with its messages and the cards' current action status. */
export async function assistantConversation(ctx: StaffContext, id?: string | null) {
  const [c] = await db
    .select()
    .from(assistantConversations)
    .where(and(eq(assistantConversations.staffId, ctx.staff.id), id ? eq(assistantConversations.id, id) : undefined))
    .orderBy(desc(assistantConversations.updatedAt))
    .limit(1);
  if (!c) {
    if (id) throw notFound("Conversation");
    return null;
  }
  const [msgs, actions] = await Promise.all([
    db.select().from(assistantMessages).where(eq(assistantMessages.conversationId, c.id)).orderBy(asc(assistantMessages.createdAt)),
    db.select({ id: assistantActions.id, status: assistantActions.status, result: assistantActions.result }).from(assistantActions).where(eq(assistantActions.conversationId, c.id)),
  ]);
  const byId = new Map(actions.map((a) => [a.id, a]));
  return {
    id: c.id,
    title: c.title,
    messages: msgs.map(view).map((m) => ({
      ...m,
      cards: m.cards.map((card) => {
        if (card.kind !== "action") return card;
        const a = byId.get(card.actionId);
        return a ? { ...card, status: a.status, links: ((a.result?.links as AssistantCard["links"] | undefined) ?? card.links) } : card;
      }),
    })),
  };
}

/** What the empty chat suggests: questions this person's reports and tools can answer. */
export async function assistantStart(ctx: StaffContext) {
  const { settings } = await assertAccess(ctx);
  const tools = (await toolsFor(ctx, settings)).map((t) => t.name);
  return suggestions({ reports: ASSISTANT_REPORTS.filter((r) => can(ctx, reportView(r.key))).map((r) => r.key), tools });
}

export interface AskInput {
  conversationId?: string | null;
  question: string;
}

/**
 * Answers one question. The model only sees what the tools return, and the tools run with this
 * person's permissions and locations; the question, every tool call and every refusal is audited.
 */
export async function askAssistant(ctx: StaffContext, input: AskInput, o: { provider?: Provider | null; now?: Date } = {}) {
  const now = o.now ?? new Date();
  const { settings, provider } = await assertAccess(ctx, o.provider);
  const question = scrubText(String(input.question ?? "").trim()).slice(0, QUESTION_MAX);
  if (!question) throw new AppError("bad_request", "Ask a question");
  await assertUnderLimit(ctx, settings, now);

  let conversationId = input.conversationId ?? null;
  const history: ChatMessage[] = [];
  if (conversationId) {
    const [c] = await db.select({ id: assistantConversations.id }).from(assistantConversations).where(and(eq(assistantConversations.id, conversationId), eq(assistantConversations.staffId, ctx.staff.id)));
    if (!c) throw notFound("Conversation");
    const prior = await db
      .select({ role: assistantMessages.role, body: assistantMessages.body })
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, c.id))
      .orderBy(desc(assistantMessages.createdAt))
      .limit(HISTORY_MESSAGES);
    for (const m of prior.reverse()) history.push({ role: m.role, content: m.body });
  } else {
    const [c] = await db.insert(assistantConversations).values({ staffId: ctx.staff.id, title: question.slice(0, 80) }).returning({ id: assistantConversations.id });
    conversationId = c.id;
  }
  const [asked] = await db.insert(assistantMessages).values({ conversationId, staffId: ctx.staff.id, role: "user", body: question, createdAt: now }).returning();
  await audit(ctx.actor, "assistant.question", "assistant_conversation", conversationId, { question, provider: provider.id, model: provider.model }, ctx.currentShopId);

  const tools = await toolsFor(ctx, settings);
  const reports = ASSISTANT_REPORTS.filter((r) => can(ctx, reportView(r.key))).map((r) => r.key);
  const system = systemPrompt({
    firstName: ctx.staff.firstName,
    roleName: ctx.staff.roleName,
    shopLogin: ctx.staff.kind === "shop",
    shops: ctx.shops.map((s) => s.name),
    everyShop: ctx.brandWide,
    today: formatDate(todayLocal(now), "EEEE, MMM d, yyyy"),
    tools: tools.map((t) => t.name),
  });
  const barbers = (await barbersAt(ctx.shopIds)).map((b) => b.name);
  // The stub runs in-process; knowing every location name lets the run_report scope check refuse the ones outside the person's scope, as it would for a real model.
  const stubShops = provider.id === "stub" ? (await db.select({ name: shops.name }).from(shops).where(eq(shops.active, true))).map((s) => s.name) : [];
  const messages: ChatMessage[] = [...history, { role: "user", content: question }];
  const cards: AssistantCard[] = [];
  const called: { name: string; args: unknown; ok: boolean }[] = [];
  let text: string | null = null;

  for (let round = 0; round < MAX_ROUNDS && text === null; round++) {
    const last = round === MAX_ROUNDS - 1 || called.length >= MAX_TOOL_CALLS;
    const r = await provider.complete({ system, messages, tools: last ? [] : tools.map((t) => t.spec), stub: { reports, shops: stubShops, barbers } });
    if (!r.toolCalls.length || last) {
      text = r.text?.trim() || null;
      break;
    }
    const calls: ToolCall[] = r.toolCalls.map((c, i) => ({ ...c, id: c.id || `call-${round}-${i}` }));
    messages.push({ role: "assistant", content: r.text ?? "", toolCalls: calls });
    for (const call of calls) {
      const content = await runTool(ctx, { settings, conversationId, now, tools, call, called, cards });
      messages.push({ role: "tool", callId: call.id, name: call.name, content });
    }
  }
  const body = scrubText(text ?? (cards.length ? "Here's what I found." : "I couldn't answer that. Try a narrower question, like one report, location or barber."));
  const [answer] = await db
    .insert(assistantMessages)
    .values({ conversationId, staffId: ctx.staff.id, role: "assistant", body, cards: scrub(cards), tools: scrub(called), createdAt: new Date(now.getTime() + 1) })
    .returning();
  await db.update(assistantConversations).set({ updatedAt: now }).where(eq(assistantConversations.id, conversationId));
  return { conversationId, messages: [view(asked), view(answer)] };
}

async function runTool(
  ctx: StaffContext,
  o: { settings: AssistantSettings; conversationId: string; now: Date; tools: Awaited<ReturnType<typeof toolsFor>>; call: ToolCall; called: { name: string; args: unknown; ok: boolean }[]; cards: AssistantCard[] },
): Promise<string> {
  const { call } = o;
  const tool = o.tools.find((t) => t.name === call.name);
  const args = scrub(call.args ?? {});
  if (o.called.length >= MAX_TOOL_CALLS) return "SUMMARY: That's the most tools one question can use. Answer with what you have.";
  let content: string;
  let ok = true;
  let error: string | undefined;
  if (!tool) {
    ok = false;
    error = "not available";
    content = `SUMMARY: ${call.name} isn't available to this person.`;
  } else {
    const parsed = tool.args.safeParse(call.args ?? {});
    if (!parsed.success) {
      ok = false;
      error = parsed.error.issues[0]?.message ?? "bad arguments";
      content = `SUMMARY: The arguments didn't fit: ${error}.`;
    } else {
      try {
        const r = await tool.run({ ctx, settings: o.settings, conversationId: o.conversationId, now: o.now }, parsed.data);
        content = r.content;
        o.cards.push(...r.cards);
        if (r.refused) {
          ok = false;
          error = r.content.replace(/^SUMMARY:\s*/, "").split("\n")[0];
        }
      } catch (e) {
        ok = false;
        if (!(e instanceof AppError)) console.error(e);
        error = e instanceof AppError ? e.message : "failed";
        content = `SUMMARY: ${e instanceof AppError ? e.message : "That didn't work."}`;
      }
    }
  }
  o.called.push({ name: call.name, args, ok });
  await audit(ctx.actor, "assistant.tool", "assistant_conversation", o.conversationId, { tool: call.name, args, ok, ...(error ? { error } : {}) }, ctx.currentShopId);
  return content;
}

// ───────────────────────────── Drafts ─────────────────────────────

/**
 * Confirms or cancels a draft. Confirming checks everything again with the person's permissions
 * now (the assistant still on for them, the permission to make it, its locations), then saves the
 * blast as a draft or creates the purchase orders the same way their pages do.
 */
export async function decideAssistantAction(ctx: StaffContext, id: string, confirm: boolean, now: Date = new Date()) {
  const [a] = await db.select().from(assistantActions).where(and(eq(assistantActions.id, id), eq(assistantActions.staffId, ctx.staff.id)));
  if (!a) throw notFound("Draft");
  if (a.status !== "pending") throw new AppError("conflict", a.status === "confirmed" ? "That's already done" : "That draft was cancelled");
  const actor: Actor = ctx.actor;
  if (!confirm) {
    await db.update(assistantActions).set({ status: "cancelled", decidedAt: now }).where(eq(assistantActions.id, a.id));
    await audit(actor, "assistant.action_cancelled", "assistant_action", a.id, { kind: a.kind }, ctx.currentShopId);
    return { status: "cancelled" as const, links: [] };
  }
  const { settings } = await assertAccess(ctx);
  if (!settings.actions) throw forbidden("Drafting with Rayz Assistant is turned off");
  if (now.getTime() - a.createdAt.getTime() > ACTION_TTL_MS) throw new AppError("conflict", "That draft is more than an hour old. Ask again for a fresh one.");
  let links: { label: string; href: string }[];
  try {
    if (a.kind === "draft_po") {
      if (!can(ctx, "po.create")) throw forbidden("Creating purchase orders needs \"Create and edit purchase orders\"");
      const r = await createPos(whoOf(ctx), { picks: a.params.picks as { shopId: string; vendorId: string }[], fill: "suggested" });
      if (!r.created.length) throw new AppError("conflict", "Nothing is due from those vendors anymore, so no purchase orders were created");
      links = r.created.map((p) => ({ label: `PO #${p.number}`, href: `/admin/purchase-orders/${p.id}` }));
    } else {
      if (!can(ctx, "campaign_center.create")) throw forbidden("Writing a blast needs Campaign Center: create");
      const blastId = await saveBlast(ctx, a.params);
      links = [{ label: "Open the draft blast", href: `/admin/campaign-center/blasts/${blastId}` }];
    }
  } catch (e) {
    const message = e instanceof AppError ? e.message : "Something went wrong";
    await db.update(assistantActions).set({ status: "failed", decidedAt: now, result: { error: message } }).where(eq(assistantActions.id, a.id));
    await audit(actor, "assistant.action_failed", "assistant_action", a.id, { kind: a.kind, error: message }, ctx.currentShopId);
    throw e;
  }
  await db.update(assistantActions).set({ status: "confirmed", decidedAt: now, result: { links } }).where(eq(assistantActions.id, a.id));
  await audit(actor, "assistant.action_confirmed", "assistant_action", a.id, { kind: a.kind, links: links.map((l) => l.href) }, ctx.currentShopId);
  return { status: "confirmed" as const, links };
}
