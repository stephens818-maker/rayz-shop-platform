import type { HandbookTopic } from "./handbook";

/** Off until HELP_WIDGET=on. A monthly cap of 0 (the default) blocks any paid model call. */
export function helpWidgetConfig(env: Record<string, string | undefined> = process.env): { on: boolean; capCents: number } {
  const cap = Number(env.HELP_WIDGET_MONTHLY_CAP_CENTS ?? "0");
  return { on: env.HELP_WIDGET === "on", capCents: Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : 0 };
}

export function helpWidgetOn(env: Record<string, string | undefined> = process.env): boolean {
  return helpWidgetConfig(env).on;
}

/**
 * How-to from the topics this person may already open. Nothing else is in the answer.
 * The caller passes handbookFor(perms), so a hidden topic cannot appear.
 */
export function handbookAnswer(topics: readonly HandbookTopic[], question: string): string {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  const ranked = topics
    .map((t) => {
      const hay = `${t.title} ${t.keywords} ${t.steps.join(" ")}`.toLowerCase();
      return { t, score: words.filter((w) => hay.includes(w)).length };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!ranked.length) {
    return "I can only answer from the handbook topics you can open. Try Help, or ask a manager. I can't book, refund, text, or change anything.";
  }
  const top = ranked[0].t;
  return [`${top.title}`, ...top.steps.map((s, i) => `${i + 1}. ${s}`), "This is a how-to only. It does not change bookings, money, or settings."].join("\n");
}
