/** "G then a letter" jumps; only those whose page the person can open are active. */
export const GO_TO = [
  { key: "h", href: "/admin", label: "Today" },
  { key: "c", href: "/admin/calendar", label: "Calendar" },
  { key: "w", href: "/admin/walk-ins", label: "Walk-ins & waitlist" },
  { key: "s", href: "/admin/sales", label: "Sales & checkout" },
  { key: "k", href: "/admin/customers", label: "Clients" },
  { key: "t", href: "/admin/clock", label: "Time clock" },
  { key: "r", href: "/admin/reports", label: "Reports" },
  { key: "m", href: "/admin/morning", label: "Morning Dashboard" },
] as const;

export interface ShortcutGroup {
  title: string;
  items: { keys: string[]; label: string }[];
}

/** What the "?" sheet lists. The page handlers use the same keys. */
export function shortcutGroups(goTo: readonly { key: string; label: string }[], mac: boolean): ShortcutGroup[] {
  const mod = mac ? "⌘" : "Ctrl";
  return [
    {
      title: "Everywhere",
      items: [
        { keys: [mod, "K"], label: "Search pages, reports, clients and actions" },
        { keys: ["/"], label: "Find a client" },
        { keys: ["?"], label: "Show these shortcuts" },
        ...goTo.map((g) => ({ keys: ["G", g.key.toUpperCase()], label: `Go to ${g.label}` })),
      ],
    },
    {
      title: "Calendar",
      items: [
        { keys: ["T"], label: "Today" },
        { keys: ["←"], label: "Previous day" },
        { keys: ["→"], label: "Next day" },
        { keys: ["["], label: "Previous barbers (when they don't all fit)" },
        { keys: ["]"], label: "Next barbers" },
        { keys: ["W"], label: "Week view" },
        { keys: ["N"], label: "New walk-in" },
        { keys: ["Esc"], label: "Close the side panel" },
      ],
    },
    {
      title: "Checkout",
      items: [
        { keys: ["1", "2", "3"], label: "Tip at the first, second or third percentage" },
        { keys: ["0"], label: "No tip" },
        { keys: ["C"], label: "Pay by cash" },
        { keys: ["D"], label: "Pay by card" },
        { keys: ["H"], label: "Hand to customer" },
        { keys: [mod, "Enter"], label: "Take the payment" },
      ],
    },
  ];
}

export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

/** A key press as one string: "k", "mod+k", "mod+enter", "arrowleft", "?", "[". Alt combinations are ignored (null). */
export function hotkeyOf(e: KeyLike): string | null {
  if (e.altKey) return null;
  const k = e.key.toLowerCase();
  if (["meta", "control", "shift", "alt"].includes(k)) return null;
  return e.metaKey || e.ctrlKey ? `mod+${k}` : k;
}

/** Single-key shortcuts stay out of the way while someone types in a field. */
export function isTypingTarget(el: { tagName?: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes((el.type ?? "text").toLowerCase());
}
