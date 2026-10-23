/**
 * Client message wording the brand can edit under Settings → Messages. Each kind has a default; a
 * saved template replaces its subject and/or body. Merge fields are written {like_this}.
 */

export const MERGE_FIELDS = {
  shop: "The shop's name as clients see it, e.g. Ray'z Moline",
  first_name: "The client's first name",
  barber: "The barber's display label",
  when: "Day, date and time of the appointment",
  address: "The shop's street and city",
  link: "The client's link to view, change or cancel",
  book_link: "The shop's booking page",
  cutoff: "How close to the time online changes close, e.g. 30 min",
  phone: "The shop's phone number",
} as const;
export type MergeField = keyof typeof MERGE_FIELDS;

export interface TemplateDef {
  label: string;
  when: string;
  subject: string;
  body: string;
  /** Marketing texts need marketing consent; these are sent only from Today's suggested actions. */
  marketing?: boolean;
}

export const TEMPLATE_DEFS = {
  confirmation: {
    label: "Booking confirmation",
    when: "Right after a booking",
    subject: "{shop}: you're booked",
    body: "{shop}: You're booked with {barber} on {when} at {address}. Cancel or reschedule: {link}",
  },
  reschedule: {
    label: "Appointment moved",
    when: "When the time or barber changes",
    subject: "{shop}: appointment moved",
    body: "{shop}: Your appointment is now {when} with {barber}. Details: {link}",
  },
  reminder_24h: {
    label: "Reminder, day before",
    when: "24 hours before",
    subject: "{shop}: see you tomorrow",
    body: "{shop}: Reminder — {when} with {barber}. Need to change it? {link}",
  },
  reminder_2h: {
    label: "Reminder, same day",
    when: "2 hours before",
    subject: "{shop}: see you soon",
    body: "{shop}: See you at {when} with {barber}. Changes allowed up to {cutoff} before: {link}",
  },
  cancellation: {
    label: "Cancellation",
    when: "When an appointment is cancelled",
    subject: "{shop}: appointment cancelled",
    body: "{shop}: Your {when} appointment was cancelled. Book again anytime: {book_link}",
  },
  time_off_reschedule: {
    label: "Barber out: pick a new time",
    when: "A manager asks a client to move because the barber is off",
    subject: "{shop}: please pick a new time",
    body: "{shop}: {barber} is out for your {when} appointment. Please pick another time or barber: {link}. Your booking stays until you change it.",
  },
  no_show_reminder: {
    label: "Extra reminder (no-show risk)",
    when: "Today: sent to clients who have missed appointments before",
    subject: "{shop}: are you still coming?",
    body: "{shop}: Hi {first_name}, just checking you're still set for {when} with {barber}. If not, please cancel so someone else can have the chair: {link}",
  },
  running_late: {
    label: "Barber running behind",
    when: "Today: sent to the next clients of a barber who is behind",
    subject: "{shop}: running a little behind",
    body: "{shop}: Hi {first_name}, {barber} is running about {delay} behind today. Your {when} appointment is still on; feel free to come a little later. Questions? {phone}",
  },
  fill_offer: {
    label: "Open chair today (marketing)",
    when: "Today: sent to clients due for a cut when a barber has open time",
    subject: "{shop}: a chair opened up today",
    body: "{shop}: Hi {first_name}, {barber} has openings today. Due for a cut? Book here: {book_link} Reply STOP to opt out.",
    marketing: true,
  },
  rebook_nudge: {
    label: "Due to rebook (marketing)",
    when: "Today: sent to regulars who are past their usual visit",
    subject: "{shop}: time for a fresh cut?",
    body: "{shop}: Hi {first_name}, it's been a while! Book your next cut: {book_link} Reply STOP to opt out.",
    marketing: true,
  },
} satisfies Record<string, TemplateDef>;

export type TemplateKind = keyof typeof TEMPLATE_DEFS;
export const TEMPLATE_KINDS = Object.keys(TEMPLATE_DEFS) as TemplateKind[];
export const isTemplateKind = (k: string): k is TemplateKind => k in TEMPLATE_DEFS;

/** Fields beyond the shared ones that a kind can use. */
const EXTRA_FIELDS: Partial<Record<TemplateKind, string[]>> = { running_late: ["delay"] };

export type SavedTemplates = Partial<Record<TemplateKind, { subject?: string; body?: string }>>;
export type MergeValues = Partial<Record<MergeField | "delay", string>>;

const FIELD_RE = /\{([a-z_]+)\}/g;
/** Two SMS segments; longer texts cost more and some phones split them badly. */
export const SMS_MAX = 320;

export function templateFor(kind: TemplateKind, saved: SavedTemplates | null | undefined) {
  const d = TEMPLATE_DEFS[kind];
  const s = saved?.[kind];
  return { subject: s?.subject?.trim() || d.subject, body: s?.body?.trim() || d.body, custom: !!(s?.subject?.trim() || s?.body?.trim()) };
}

export function fill(text: string, values: MergeValues) {
  return text
    .replace(FIELD_RE, (_, f: string) => values[f as MergeField] ?? "")
    .replace(/ {2,}/g, " ")
    .replace(/ ([.,!?])/g, "$1")
    .replace(/ (?:at|on|with)(?=[.,!?])/g, "")
    .trim();
}

/** What's wrong with a template, or null. Unknown fields would go out blank, so they're refused. */
export function templateProblem(kind: TemplateKind, t: { subject?: string; body?: string }): string | null {
  const allowed = new Set<string>([...Object.keys(MERGE_FIELDS), ...(EXTRA_FIELDS[kind] ?? [])]);
  for (const [part, text] of [
    ["Subject", t.subject ?? ""],
    ["Message", t.body ?? ""],
  ] as const) {
    for (const [, f] of text.matchAll(FIELD_RE)) if (!allowed.has(f)) return `${part}: {${f}} isn't a merge field. Use ${[...allowed].map((x) => `{${x}}`).join(", ")}.`;
    if (/\{[^}]*$|^[^{]*\}/.test(text)) return `${part}: a { or } isn't closed`;
  }
  if (t.body !== undefined && !t.body.trim()) return "The message can't be empty";
  if (t.subject && t.subject.length > 120) return "Keep the subject under 120 characters";
  if (t.body && t.body.length > 1000) return "Keep the message under 1,000 characters";
  const def = TEMPLATE_DEFS[kind] as TemplateDef;
  if (def.marketing && t.body && !/\bSTOP\b/.test(t.body)) return "Marketing texts must tell clients how to opt out (e.g. Reply STOP to opt out)";
  const needsLink = ["confirmation", "reschedule", "reminder_24h", "reminder_2h", "time_off_reschedule", "no_show_reminder"] as TemplateKind[];
  if (needsLink.includes(kind) && t.body && !t.body.includes("{link}")) return "Keep {link} in this message so clients can change or cancel";
  return null;
}

/** A sample filled-in message, for the editor's preview and length count. */
export const SAMPLE: MergeValues = {
  shop: "Ray'z Moline",
  first_name: "Jordan",
  barber: "Marcus T.",
  when: "Fri, Oct 23, 2:30 PM",
  address: "1630 5th Ave, Moline",
  link: "https://rayz.example/a/AB12CD",
  book_link: "https://rayz.example/book/moline",
  cutoff: "30 min",
  phone: "(309) 555-0100",
  delay: "15 min",
};

export const cutoffText = (min: number) => (min >= 60 && min % 60 === 0 ? `${min / 60} hr` : `${min} min`);
