/** One row in the Cmd-K palette: a page, a report, a shop to switch to, or an action. */
export interface Command {
  id: string;
  label: string;
  group: string;
  href?: string;
  /** Other words it answers to ("money", "payroll"); matched after the label. */
  keywords?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const words = (s: string) => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Letters of `q` in order inside `s`, closer together scoring higher; null when they aren't all there. */
function subsequence(q: string, s: string): number | null {
  let at = -1;
  let gaps = 0;
  for (const ch of q) {
    const i = s.indexOf(ch, at + 1);
    if (i < 0) return null;
    if (at >= 0) gaps += i - at - 1;
    at = i;
  }
  return Math.max(1, 20 - gaps);
}

function tokenScore(t: string, c: Command): number | null {
  const label = norm(c.label);
  if (label.startsWith(t)) return 100;
  if (words(c.label).some((w) => w.startsWith(t))) return 80;
  if (label.includes(t)) return 60;
  const extra = `${c.keywords ?? ""} ${c.group}`;
  if (words(extra).some((w) => w.startsWith(t))) return 40;
  if (t.length >= 2) return subsequence(t, label.replace(/\s+/g, ""));
  return null;
}

/** How well a query matches: every word must match somewhere; null when one doesn't. */
export function commandScore(query: string, c: Command): number | null {
  const tokens = words(query);
  if (!tokens.length) return 0;
  let total = 0;
  for (const t of tokens) {
    const s = tokenScore(t, c);
    if (s === null) return null;
    total += s;
  }
  return total;
}

/** Every word of the query starts a word of the label: "rock isl" for "Switch to Rock Island". Such a page or shop is listed above client matches. */
export function strongMatch(query: string, c: Command): boolean {
  const n = words(query).length;
  return n > 0 && (commandScore(query, c) ?? 0) >= 80 * n;
}

/** Best matches first; ties keep the shorter label, then the original order. An empty query keeps the list as is. */
export function rankCommands<T extends Command>(query: string, items: T[], limit = 50): T[] {
  if (!words(query).length) return items.slice(0, limit);
  return items
    .map((c, i) => ({ c, i, s: commandScore(query, c) }))
    .filter((x): x is { c: T; i: number; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.c.label.length - b.c.label.length || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.c);
}
