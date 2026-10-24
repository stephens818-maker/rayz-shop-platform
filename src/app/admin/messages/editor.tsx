"use client";

import { useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { MERGE_FIELDS, SAMPLE, SMS_MAX, type TemplateKind, fill, templateProblem } from "@/domain/message-templates";
import { saveTemplateAction } from "./actions";

export interface TemplateRow {
  kind: TemplateKind;
  label: string;
  when: string;
  marketing: boolean;
  subject: string;
  body: string;
  custom: boolean;
  defaults: { subject: string; body: string };
}

export function MergeFieldList() {
  return (
    <Card>
      <CardHeader title="Merge fields" subtitle="Type these in braces; each is filled in per client when the message goes out." />
      <dl className="grid gap-x-6 gap-y-1 p-4 text-sm sm:grid-cols-2">
        {Object.entries(MERGE_FIELDS).map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="font-mono text-zinc-900">{`{${k}}`}</dt>
            <dd className="text-zinc-600">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function TemplateEditor({ row }: { row: TemplateRow }) {
  const { pending, error, run } = useAction();
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.body);
  const [saved, setSaved] = useState<string | null>(null);
  const preview = fill(body, SAMPLE);
  const problem = templateProblem(row.kind, { subject, body });
  const dirty = subject !== row.subject || body !== row.body;
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {row.label}
            {row.custom ? <Badge tone="blue">Edited</Badge> : <Badge>Default</Badge>}
            {row.marketing && <Badge tone="amber">Marketing: needs marketing consent</Badge>}
          </span>
        }
        subtitle={row.when}
      />
      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Field label="Email subject">
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message (text and email)">
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-medium text-zinc-700">Preview</p>
          <p className="rounded-lg bg-zinc-100 p-3 text-sm text-zinc-800">{preview}</p>
          <p className={preview.length > SMS_MAX ? "text-xs text-amber-700" : "text-xs text-zinc-500"}>
            {preview.length} characters{preview.length > SMS_MAX ? ` — over ${SMS_MAX}, so texts split into 3+ parts` : ""}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-zinc-100 px-4 py-3 text-sm">
        <Button disabled={pending || !dirty || !!problem} onClick={() => run(() => saveTemplateAction(row.kind, { subject, body }), () => setSaved("Saved. The next messages use it."))}>
          Save
        </Button>
        {row.custom && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(
                () => saveTemplateAction(row.kind, null),
                () => {
                  setSubject(row.defaults.subject);
                  setBody(row.defaults.body);
                  setSaved("Back to the default wording.");
                },
              )
            }
          >
            Use default
          </Button>
        )}
        {problem && dirty && <span className="text-amber-700">{problem}</span>}
        {saved && !dirty && <span className="text-emerald-700">{saved}</span>}
      </div>
      {error && (
        <div className="px-4 pb-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
    </Card>
  );
}
