import "server-only";
import { stubAnswer, stubPlan } from "@/domain/assistant";
import { AppError } from "../errors";

/**
 * The language model behind Rayz Assistant, picked from the environment: ASSISTANT_PROVIDER
 * ("openai", "anthropic", "stub" or "off"), else whichever of OPENAI_API_KEY and ANTHROPIC_API_KEY
 * is set, else the stub outside production. ASSISTANT_MODEL overrides the model. Keys are read here
 * on the server only and never shown or stored.
 */

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; callId: string; name: string; content: string };
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
}
export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  /** For the stub's router; the real providers get the same facts in the system prompt. */
  stub?: { reports: string[]; shops: string[]; barbers: string[] };
}
export interface Completion {
  text: string | null;
  toolCalls: ToolCall[];
}
export type ProviderId = "openai" | "anthropic" | "stub";
export interface Provider {
  id: ProviderId;
  model: string;
  /** How the provider is asked not to keep what it's sent. */
  retention: string;
  complete(r: CompletionRequest): Promise<Completion>;
}

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;
const TIMEOUT_MS = 45_000;

const parseArgs = (s: unknown): Record<string, unknown> => {
  if (s && typeof s === "object") return s as Record<string, unknown>;
  try {
    const v = JSON.parse(String(s ?? "{}"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

async function post(f: Fetch, provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await f(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new AppError("internal", `The assistant couldn't reach ${provider}. Try again in a moment.`);
  }
  if (res.status === 429) throw new AppError("rate_limited", `${provider} is busy right now. Try again in a minute.`);
  if (!res.ok) {
    console.error(`assistant: ${provider} answered ${res.status}`);
    throw new AppError("internal", `The assistant's provider (${provider}) didn't answer. Try again in a moment.`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Chat Completions with `store: false`, so OpenAI doesn't keep the conversation for its dashboard, evals or distillation. */
export function openAiProvider(key: string, model: string, f: Fetch = fetch): Provider {
  return {
    id: "openai",
    model,
    retention: "Sent with store: false. Ask OpenAI for zero data retention on the API key's organization to stop abuse-monitoring logs too.",
    async complete(r) {
      const messages = [
        { role: "system", content: r.system },
        ...r.messages.map((m) =>
          m.role === "tool"
            ? { role: "tool", tool_call_id: m.callId, content: m.content }
            : m.role === "assistant" && m.toolCalls?.length
              ? { role: "assistant", content: m.content || null, tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
              : { role: m.role, content: m.content },
        ),
      ];
      const body = {
        model,
        messages,
        store: false,
        max_completion_tokens: 1200,
        ...(r.tools.length ? { tools: r.tools.map((t) => ({ type: "function", function: t })), tool_choice: "auto" } : {}),
      };
      const out = await post(f, "OpenAI", "https://api.openai.com/v1/chat/completions", { authorization: `Bearer ${key}` }, body);
      const msg = ((out.choices as { message?: Record<string, unknown> }[] | undefined)?.[0]?.message ?? {}) as { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] };
      return { text: msg.content ?? null, toolCalls: (msg.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) })) };
    },
  };
}

/** The Messages API. Anthropic has no per-request retention switch; zero data retention is set on the organization by agreement. */
export function anthropicProvider(key: string, model: string, f: Fetch = fetch): Provider {
  return {
    id: "anthropic",
    model,
    retention: "API inputs aren't used for training. Zero data retention is an agreement on the API key's organization; ask Anthropic to turn it on.",
    async complete(r) {
      const messages: { role: "user" | "assistant"; content: unknown }[] = [];
      for (const m of r.messages) {
        if (m.role === "tool") {
          const block = { type: "tool_result", tool_use_id: m.callId, content: m.content };
          const prev = messages[messages.length - 1];
          if (prev?.role === "user" && Array.isArray(prev.content)) (prev.content as unknown[]).push(block);
          else messages.push({ role: "user", content: [block] });
        } else if (m.role === "assistant" && m.toolCalls?.length) {
          messages.push({ role: "assistant", content: [...(m.content ? [{ type: "text", text: m.content }] : []), ...m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))] });
        } else messages.push({ role: m.role, content: m.content });
      }
      const body = { model, max_tokens: 1200, system: r.system, messages, ...(r.tools.length ? { tools: r.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}) };
      const out = await post(f, "Anthropic", "https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, body);
      const blocks = (out.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[] | undefined) ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim();
      return { text: text || null, toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: String(b.id), name: String(b.name), args: parseArgs(b.input) })) };
    },
  };
}

/** Runs without a key: routes the question to a tool by keywords, then reads back the tools' summaries. */
export function stubProvider(): Provider {
  return {
    id: "stub",
    model: "keyword router",
    retention: "Nothing leaves the server.",
    async complete(r) {
      const lastUser = r.messages.map((m) => m.role).lastIndexOf("user");
      const after = r.messages.slice(lastUser + 1).filter((m): m is Extract<ChatMessage, { role: "tool" }> => m.role === "tool");
      if (after.length) return { text: stubAnswer(after), toolCalls: [] };
      const q = r.messages[lastUser];
      const plan = q?.role === "user" ? stubPlan(q.content, { tools: r.tools.map((t) => t.name), reports: r.stub?.reports ?? [], shops: r.stub?.shops ?? [], barbers: r.stub?.barbers ?? [] }) : null;
      return plan ? { text: null, toolCalls: [{ id: "stub-1", ...plan }] } : { text: stubAnswer([]), toolCalls: [] };
    },
  };
}

export const DEFAULT_MODELS: Record<Exclude<ProviderId, "stub">, string> = { openai: "gpt-4.1-mini", anthropic: "claude-sonnet-4-5" };

/** The configured provider, or null when the assistant can't run (turned off, or a key is missing in production). */
export function assistantProvider(env: Env = process.env, f: Fetch = fetch): Provider | null {
  const choice = (env.ASSISTANT_PROVIDER ?? "").trim().toLowerCase();
  const model = env.ASSISTANT_MODEL?.trim();
  if (choice === "off") return null;
  if (choice === "openai" || (!choice && env.OPENAI_API_KEY)) return env.OPENAI_API_KEY ? openAiProvider(env.OPENAI_API_KEY, model || DEFAULT_MODELS.openai, f) : null;
  if (choice === "anthropic" || (!choice && env.ANTHROPIC_API_KEY)) return env.ANTHROPIC_API_KEY ? anthropicProvider(env.ANTHROPIC_API_KEY, model || DEFAULT_MODELS.anthropic, f) : null;
  if (choice === "stub" || (!choice && env.NODE_ENV !== "production")) return stubProvider();
  return null;
}

/** For the settings page: which provider and model, never the key. */
export function providerStatus(env: Env = process.env): { id: ProviderId | null; model: string | null; retention: string | null; problem: string | null } {
  const p = assistantProvider(env, (() => Promise.reject(new Error("status only"))) as Fetch);
  if (p) return { id: p.id, model: p.model, retention: p.retention, problem: null };
  const choice = (env.ASSISTANT_PROVIDER ?? "").trim().toLowerCase();
  const problem =
    choice === "off"
      ? "ASSISTANT_PROVIDER is off, so nobody sees the assistant."
      : choice === "openai" || choice === "anthropic"
        ? `ASSISTANT_PROVIDER is ${choice} but ${choice === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} isn't set.`
        : "No API key is set. Add OPENAI_API_KEY or ANTHROPIC_API_KEY to the server's environment.";
  return { id: null, model: null, retention: null, problem };
}
