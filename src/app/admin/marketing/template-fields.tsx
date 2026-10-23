"use client";

import { Field, Input, Textarea, cx } from "@/components/ui";
import { CHANNELS, CHANNEL_LABEL, Channel, MARKETING_FIELDS, MARKETING_SMS_MAX, SAMPLE_VALUES, Templates, fill, render } from "@/domain/marketing";

/** Channels in the order they're tried: each client gets one message, on the first they agreed to. */
export function ChannelOrder({ value, onChange, disabled }: { value: Channel[]; onChange: (v: Channel[]) => void; disabled?: boolean }) {
  const off = CHANNELS.filter((c) => !value.includes(c));
  const move = (i: number, d: -1 | 1) => {
    const next = [...value];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    onChange(next);
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {value.map((c, i) => (
        <span key={c} className="inline-flex items-center gap-1 rounded-full bg-zinc-900 px-3 py-1 text-white">
          {i + 1}. {CHANNEL_LABEL[c]}
          {!disabled && (
            <>
              {i > 0 && (
                <button type="button" className="px-1 text-zinc-300 hover:text-white" onClick={() => move(i, -1)} aria-label={`Try ${CHANNEL_LABEL[c]} earlier`}>
                  ←
                </button>
              )}
              {value.length > 1 && (
                <button type="button" className="px-1 text-zinc-300 hover:text-white" onClick={() => onChange(value.filter((x) => x !== c))} aria-label={`Don't send by ${CHANNEL_LABEL[c]}`}>
                  ×
                </button>
              )}
            </>
          )}
        </span>
      ))}
      {!disabled &&
        off.map((c) => (
          <button key={c} type="button" className="rounded-full px-3 py-1 text-zinc-600 ring-1 ring-zinc-300 hover:ring-zinc-500" onClick={() => onChange([...value, c])}>
            + {CHANNEL_LABEL[c]}
          </button>
        ))}
    </div>
  );
}

export function MergeFields() {
  return (
    <p className="text-xs text-zinc-500">
      Merge fields:{" "}
      {Object.entries(MARKETING_FIELDS).map(([k, v], i) => (
        <span key={k} title={v}>
          {i ? ", " : ""}
          <code className="rounded bg-zinc-100 px-1">{`{${k}}`}</code>
        </span>
      ))}
      . Hover one for what it fills in.
    </p>
  );
}

/** The wording for each channel the campaign uses, with a preview filled in with sample values. */
export function TemplateFields({ value, onChange, channels, disabled, address }: { value: Templates; onChange: (t: Templates) => void; channels: Channel[]; disabled?: boolean; address: string }) {
  const set = (k: keyof Templates, v: string) => onChange({ ...value, [k]: v });
  const preview = render(value, SAMPLE_VALUES, { brand: "Ray'z Barber Shop", address: address || "(the brand's postal address)", unsubscribeUrl: "https://rayz.example/m/…/unsubscribe" });
  const smsLen = fill(value.sms, SAMPLE_VALUES).length;
  return (
    <div className="space-y-4">
      <MergeFields />
      {channels.includes("sms") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Field label="Text" hint={<span className={cx(smsLen > MARKETING_SMS_MAX && "text-red-600")}>{`${smsLen} of ${MARKETING_SMS_MAX} characters with the sample filled in. Must say how to opt out (Reply STOP to opt out).`}</span>}>
            <Textarea rows={4} value={value.sms} disabled={disabled} onChange={(e) => set("sms", e.target.value)} />
          </Field>
          <Preview title="Text preview">{preview.sms}</Preview>
        </div>
      )}
      {channels.includes("email") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Email subject">
              <Input value={value.emailSubject} disabled={disabled} onChange={(e) => set("emailSubject", e.target.value)} />
            </Field>
            <Field label="Email" hint="The brand's postal address and an unsubscribe link are added at the bottom.">
              <Textarea rows={6} value={value.emailBody} disabled={disabled} onChange={(e) => set("emailBody", e.target.value)} />
            </Field>
          </div>
          <Preview title={preview.email.subject || "Email preview"}>{preview.email.body}</Preview>
        </div>
      )}
      {channels.includes("push") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Push title">
              <Input value={value.pushTitle} disabled={disabled} onChange={(e) => set("pushTitle", e.target.value)} />
            </Field>
            <Field label="Push">
              <Input value={value.pushBody} disabled={disabled} onChange={(e) => set("pushBody", e.target.value)} />
            </Field>
          </div>
          <Preview title={preview.push.title || "Push preview"}>{preview.push.body}</Preview>
        </div>
      )}
    </div>
  );
}

function Preview({ title, children }: { title: string; children: string }) {
  return (
    <div className="rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
      <div className="mb-1 text-xs font-semibold text-zinc-500">{title}</div>
      <pre className="whitespace-pre-wrap font-sans text-sm text-zinc-800">{children}</pre>
    </div>
  );
}
