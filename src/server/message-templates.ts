import { SAMPLE, SMS_MAX, TEMPLATE_DEFS, TEMPLATE_KINDS, fill, templateFor } from "@/domain/message-templates";
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
