import { sql } from "drizzle-orm";
import { db } from "@/db";
import { brandSettings } from "@/db/schema";
import { SAMPLE, SMS_MAX, TEMPLATE_DEFS, TEMPLATE_KINDS, TemplateKind, fill, templateFor, templateProblem } from "@/domain/message-templates";
import { Actor, audit } from "./audit";
import { AppError } from "./errors";
import { savedTemplates } from "./notifications/queue";

export async function templateRows() {
  const saved = await savedTemplates();
  return TEMPLATE_KINDS.map((kind) => {
    const def = TEMPLATE_DEFS[kind];
    const t = templateFor(kind, saved);
    const sample = fill(t.body, SAMPLE);
    return { kind, label: def.label, when: def.when, marketing: "marketing" in def, subject: t.subject, body: t.body, custom: t.custom, defaults: { subject: def.subject, body: def.body }, sample, tooLong: sample.length > SMS_MAX };
  });
}

/** Saves the wording for one kind; null puts the default back. */
export async function saveTemplate(kind: TemplateKind, t: { subject: string; body: string } | null, actor: Actor) {
  if (!(kind in TEMPLATE_DEFS)) throw new AppError("bad_request", "Unknown message");
  if (t) {
    const problem = templateProblem(kind, t);
    if (problem) throw new AppError("bad_request", problem);
  }
  const def = TEMPLATE_DEFS[kind];
  const value = t && (t.subject.trim() !== def.subject || t.body.trim() !== def.body) ? { subject: t.subject.trim(), body: t.body.trim() } : null;
  await db
    .update(brandSettings)
    .set({ messageTemplates: value ? sql`${brandSettings.messageTemplates} || ${JSON.stringify({ [kind]: value })}::jsonb` : sql`${brandSettings.messageTemplates} - ${kind}` });
  await audit(actor, value ? "settings.template" : "settings.template_reset", "brand_settings", kind, { kind, ...(value ?? {}) }, null);
  return { custom: !!value };
}
