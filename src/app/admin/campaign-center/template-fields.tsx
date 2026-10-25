"use client";

import { useRef, useState } from "react";
import { Button, Field, Input, Textarea, cx } from "@/components/ui";
import { REFINE_LABEL, REFINE_MAX, REFINE_STYLES, type RefinePart, type RefineStyle } from "@/domain/campaign-refine";
import { BRAND_COLOR } from "@/domain/marketing-email";
import {
  CHANNELS,
  CHANNEL_LABEL,
  Channel,
  MARKETING_FIELDS,
  MARKETING_SMS_MAX,
  MERGE_DEFAULTS,
  SAMPLE_VALUES,
  STOP_LINE,
  Templates,
  render,
  smsAppends,
  smsSegments,
  smsText,
  type MarketingValues,
} from "@/domain/marketing";
import { refineCopyAction, uploadEmailImageAction } from "./actions";
import { cropBanner, enhance, fileToEmailImage, loadImage, type EditedImage } from "./email-image-tools";

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

type TextPart = Exclude<keyof Templates, "emailImage">;
type FieldEl = HTMLInputElement | HTMLTextAreaElement;

/** Merge fields as chips: a click puts the field where the cursor was in the last box you typed in. */
export function MergeFields({ extra, onInsert, target }: { extra?: Record<string, string>; onInsert?: (field: string) => void; target?: string }) {
  const fields = Object.entries({ ...MARKETING_FIELDS, ...extra });
  const defaults = Object.entries(MERGE_DEFAULTS)
    .map(([k, v]) => `{${k}} says “${v}”`)
    .join(" and ");
  return (
    <div className="space-y-1 text-xs text-zinc-500" data-testid="merge-fields">
      <div className="flex flex-wrap items-center gap-1.5">
        <span>{onInsert ? `Insert${target ? ` into ${target.toLowerCase()}` : ""}:` : "Merge fields:"}</span>
        {fields.map(([k, v]) =>
          onInsert ? (
            <button
              key={k}
              type="button"
              title={v}
              className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-200"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onInsert(k)}
            >{`{${k}}`}</button>
          ) : (
            <code key={k} title={v} className="rounded bg-zinc-100 px-1">{`{${k}}`}</code>
          ),
        )}
      </div>
      <p>
        Add a fallback after a bar for clients missing a value: <code className="rounded bg-zinc-100 px-1">{"{first_name|friend}"}</code>. Without one, {defaults}.
      </p>
    </div>
  );
}

/** The wording for each channel the campaign uses, with a preview filled in with sample values. */
export function TemplateFields({
  value,
  onChange,
  channels,
  disabled,
  address,
  extraFields,
  sample,
  color,
}: {
  value: Templates;
  onChange: (t: Templates) => void;
  channels: Channel[];
  disabled?: boolean;
  address: string;
  extraFields?: Record<string, string>;
  /** Real values for the preview, such as the chosen coupon's code. */
  sample?: Partial<MarketingValues>;
  /** The booking button's color; the brand's red unless a location has its own. */
  color?: string | null;
}) {
  const latest = useRef(value);
  latest.current = value;
  const set = (patch: Partial<Templates>) => onChange({ ...latest.current, ...patch });
  const els = useRef<Partial<Record<TextPart, FieldEl | null>>>({});
  const firstPart: TextPart = channels.includes("sms") ? "sms" : channels.includes("email") ? "emailBody" : "pushBody";
  const [focus, setFocus] = useState<TextPart | null>(null);
  const target = focus && (focus !== "sms" || channels.includes("sms")) ? focus : firstPart;

  const bind = (k: TextPart) => ({
    ref: (el: FieldEl | null) => {
      els.current[k] = el;
    },
    value: value[k] ?? "",
    disabled,
    onFocus: () => setFocus(k),
    onChange: (e: React.ChangeEvent<FieldEl>) => set({ [k]: e.target.value }),
  });

  const insert = (field: string) => {
    const el = els.current[target];
    const cur = latest.current[target] ?? "";
    const [a, b] = el && document.activeElement === el ? [el.selectionStart ?? cur.length, el.selectionEnd ?? cur.length] : [cur.length, cur.length];
    const tag = `{${field}}`;
    const pad = a > 0 && !/\s$/.test(cur.slice(0, a)) ? " " : "";
    set({ [target]: cur.slice(0, a) + pad + tag + cur.slice(b) });
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const at = a + pad.length + tag.length;
      el.setSelectionRange(at, at);
    });
  };

  const values = { ...SAMPLE_VALUES, ...sample };
  const preview = render(value, values, { brand: "Ray'z Barber Shop", address: address || "(the brand's postal address)", unsubscribeUrl: "https://rayz.example/m/…/unsubscribe" });
  const seg = smsSegments(smsText(value.sms, values));
  const appends = smsAppends(value.sms);
  const extra = Object.keys(extraFields ?? {});
  const refine = (part: RefinePart) => (disabled ? null : <RefineBar part={part} text={value[part] ?? ""} extraFields={extra} onRefined={(t) => set({ [part]: t })} />);

  return (
    <div className="space-y-4" data-testid="template-fields">
      <MergeFields extra={extraFields} onInsert={disabled ? undefined : insert} target={TEMPLATE_TARGET[target]} />
      {channels.includes("sms") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-1.5">
            <Field
              label="Text"
              hint={
                <span data-testid="sms-counter" className={cx(seg.chars > MARKETING_SMS_MAX && "font-medium text-red-600")}>
                  {seg.chars} characters · {seg.segments} {seg.segments === 1 ? "segment" : "segments"} of {seg.perSegment}
                  {seg.unicode ? " (an emoji or special character makes segments shorter)" : ""} · at most {MARKETING_SMS_MAX}, with the sample filled in and what&apos;s added
                </span>
              }
            >
              <Textarea rows={4} {...bind("sms")} />
            </Field>
            <p className="text-xs text-zinc-500" data-testid="sms-appends">
              {appends.link || appends.stop ? (
                <>
                  Added at the end automatically: {appends.link && <span className="rounded bg-blue-50 px-1 text-blue-800">the booking short link</span>}
                  {appends.link && appends.stop && " and "}
                  {appends.stop && <span className="rounded bg-blue-50 px-1 text-blue-800">“{STOP_LINE}”</span>}.
                </>
              ) : (
                "Your text places the booking link and says how to opt out, so nothing is added."
              )}
            </p>
            {refine("sms")}
          </div>
          <Preview title="Text preview">{preview.sms}</Preview>
        </div>
      )}
      {channels.includes("email") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Email subject">
              <Input {...bind("emailSubject")} />
            </Field>
            {refine("emailSubject")}
            <Field label="Headline" hint="Large type at the top of the email. Leave blank for none.">
              <Input {...bind("emailHeadline")} />
            </Field>
            <EmailImageField value={value} disabled={disabled} extraFields={extra} onChange={set} bindAlt={bind("emailImageAlt")} />
            <Field label="Email" hint="The brand's postal address and an unsubscribe link are added at the bottom.">
              <Textarea rows={6} {...bind("emailBody")} />
            </Field>
            {refine("emailBody")}
            <div className="flex items-end gap-2">
              <Field label="Booking button" hint="Links to the client's booking page, tracked. Leave blank for no button." className="flex-1">
                <Input {...bind("emailCta")} placeholder="Book now" />
              </Field>
              <span
                data-testid="cta-swatch"
                className="mb-5 inline-flex h-9 shrink-0 items-center rounded-lg px-3 text-sm font-semibold text-white"
                style={{ background: color || BRAND_COLOR }}
                title="The brand's color"
              >
                {preview.email.cta?.label || "No button"}
              </span>
            </div>
          </div>
          <Preview title={preview.email.subject || "Email preview"}>{preview.email.text}</Preview>
        </div>
      )}
      {channels.includes("push") && (
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Push title" hint={<Count n={preview.push.title.length} max={REFINE_MAX.pushTitle} />}>
              <Input {...bind("pushTitle")} />
            </Field>
            <Field label="Push" hint={<Count n={preview.push.body.length} max={REFINE_MAX.pushBody} />}>
              <Textarea rows={2} {...bind("pushBody")} />
            </Field>
            {refine("pushBody")}
          </div>
          <Preview title={preview.push.title || "Push preview"}>{preview.push.body}</Preview>
        </div>
      )}
    </div>
  );
}

const TEMPLATE_TARGET: Record<TextPart, string> = {
  sms: "the text",
  emailSubject: "the subject",
  emailHeadline: "the headline",
  emailBody: "the email",
  emailCta: "the button",
  emailImageAlt: "the image description",
  pushTitle: "the push title",
  pushBody: "the push",
};

function Count({ n, max }: { n: number; max: number }) {
  return <span className={cx(n > max && "font-medium text-red-600")}>{`${n} of ${max} characters with the sample filled in`}</span>;
}

/** "Refine with AI": rewrites one part shorter, friendlier, more urgent, clearer, or as asked, keeping merge fields. */
function RefineBar({ part, text, extraFields, onRefined }: { part: RefinePart; text: string; extraFields: string[]; onRefined: (t: string) => void }) {
  const [busy, setBusy] = useState<RefineStyle | null>(null);
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [undo, setUndo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (style: RefineStyle) => {
    setBusy(style);
    setError(null);
    const r = await refineCopyAction({ part, style, text, instruction: style === "custom" ? instruction : "", extraFields, context: null });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setUndo(text);
    setAsking(false);
    onRefined(r.data.text);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid={`refine-${part}`}>
      <span className="font-medium text-zinc-600">Refine with AI:</span>
      {REFINE_STYLES.map((s) => (
        <button
          key={s}
          type="button"
          disabled={!!busy || (!text.trim() && s !== "custom")}
          onClick={() => (s === "custom" ? setAsking((x) => !x) : run(s))}
          className={cx("rounded-full px-2 py-0.5 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-50", asking && s === "custom" && "bg-zinc-100")}
        >
          {busy === s ? "…" : REFINE_LABEL[s]}
        </button>
      ))}
      {undo !== null && (
        <button
          type="button"
          className="text-blue-700 underline"
          onClick={() => {
            onRefined(undo);
            setUndo(null);
          }}
        >
          Undo
        </button>
      )}
      {asking && (
        <span className="flex w-full items-center gap-1.5">
          <Input className="h-8 flex-1 text-xs" maxLength={200} placeholder="e.g. mention the new Saturday hours" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
          <Button type="button" size="sm" variant="secondary" disabled={!!busy || !text.trim() || !instruction.trim()} onClick={() => run("custom")}>
            {busy === "custom" ? "Refining…" : "Refine"}
          </Button>
        </span>
      )}
      {error && <span className="w-full text-red-600">{error}</span>}
    </div>
  );
}

/** The header image: upload or replace (shrunk to 1200px), an https link, remove, its description, and "Refine image". */
function EmailImageField({
  value,
  disabled,
  extraFields,
  onChange,
  bindAlt,
}: {
  value: Templates;
  disabled?: boolean;
  extraFields: string[];
  onChange: (patch: Partial<Templates>) => void;
  bindAlt: React.ComponentProps<"input">;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const src = value.emailImage ?? "";
  const uploaded = src.match(/^\/mi\/([0-9a-f-]{36})$/)?.[1] ?? null;

  const save = async (label: string, make: () => Promise<EditedImage>, sourceId: string | null) => {
    setBusy(label);
    setError(null);
    try {
      const img = await make();
      const r = await uploadEmailImageAction({ ...img, alt: value.emailImageAlt ?? "", sourceId });
      if (!r.ok) throw new Error(r.error);
      onChange({ emailImage: r.data.src });
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work; try another image");
    } finally {
      setBusy(null);
    }
  };
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (f) void save("Uploading…", () => fileToEmailImage(f), null);
  };
  const refineImage = (label: string, fn: (img: HTMLImageElement) => EditedImage) => uploaded && void save(label, async () => fn(await loadImage(src)), uploaded);
  const describe = async () => {
    setBusy("Describing…");
    setError(null);
    const r = await refineCopyAction({
      part: "emailImageAlt",
      style: "custom",
      text: "",
      extraFields,
      context: { emailSubject: value.emailSubject, emailHeadline: value.emailHeadline ?? "", emailBody: value.emailBody },
    });
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onChange({ emailImageAlt: r.data.text });
  };

  return (
    <div className="space-y-2 rounded-lg p-3 ring-1 ring-zinc-200" data-testid="email-image">
      <div className="flex items-center justify-between text-xs font-medium text-zinc-700">
        <span>Image</span>
        {busy && <span className="text-zinc-500">{busy}</span>}
      </div>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={value.emailImageAlt || "Email image"} className="max-h-40 w-full rounded-md object-cover ring-1 ring-zinc-200" />
      ) : (
        <div className="grid h-20 place-items-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-400">No image. It sits above the headline.</div>
      )}
      {!disabled && (
        <div className="flex flex-wrap gap-1.5">
          <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick} />
          <Button type="button" size="sm" variant="secondary" disabled={!!busy} onClick={() => file.current?.click()}>
            {src ? "Replace image" : "Upload image"}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => setLinking((x) => !x)}>
            Use a link
          </Button>
          {src && (
            <Button type="button" size="sm" variant="ghost" disabled={!!busy} onClick={() => onChange({ emailImage: "", emailImageAlt: "" })}>
              Remove
            </Button>
          )}
        </div>
      )}
      {!disabled && linking && <Input placeholder="https://…" value={uploaded ? "" : src} onChange={(e) => onChange({ emailImage: e.target.value.trim() })} />}
      {!disabled && src && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="refine-image">
          <span className="font-medium text-zinc-600">Refine image:</span>
          <button type="button" disabled={!!busy || !uploaded} className="rounded-full px-2 py-0.5 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-50" onClick={() => refineImage("Enhancing…", enhance)}>
            Auto-enhance
          </button>
          <button type="button" disabled={!!busy || !uploaded} className="rounded-full px-2 py-0.5 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-50" onClick={() => refineImage("Cropping…", cropBanner)}>
            Crop to banner
          </button>
          <button type="button" disabled={!!busy} className="rounded-full px-2 py-0.5 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-50" onClick={describe}>
            Describe with AI
          </button>
          {!uploaded && <span className="text-zinc-400">Upload the image to enhance or crop it.</span>}
        </div>
      )}
      {src && (
        <Field label="Description (alt text)" hint="Shown when an email app hides images, and read aloud by screen readers.">
          <Input {...bindAlt} />
        </Field>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
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
