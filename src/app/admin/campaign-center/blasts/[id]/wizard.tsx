"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Chips, toggle } from "@/components/chips";
import { SegmentFilters } from "@/components/segment-filters";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Textarea, cx } from "@/components/ui";
import type { FilterOptions, PanelSees } from "@/domain/client-filters";
import { AB_METRICS, AB_METRIC_LABEL, FREQS, FREQ_LABEL, HOLDOUT_MAX, abChanges, variantTemplates, type AbMetric, type Freq } from "@/domain/campaign-schedule";
import { CHANNELS, CHANNEL_LABEL, CLIENT_STAGES, EMPTY_SEGMENT, STAGE_FIELDS, STOP_LINE, stageSegment, type Channel, type ClientStage, type Segment, type Templates } from "@/domain/marketing";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { cancelBlastAction, draftBlastAction, previewBlastAction, saveBlastAction, scheduleBlastAction } from "../../actions";
import { ChannelPreview } from "../../channel-preview";
import { ChannelOrder, TemplateFields } from "../../template-fields";
import { TestSend } from "../../test-send";

export interface WizardBlast {
  id: string;
  name: string;
  status: string;
  channels: Channel[];
  templates: Templates;
  segment: Segment;
  promoId: string | null;
  shopIds: string[];
  scheduledAt: string | null;
  sentAt: string | null;
  sent: number;
  campaignType: "update" | "promotion";
  recurrence: { freq: Exclude<Freq, "once">; endsOn: string | null } | null;
  ab: { testPct: number; metric: AbMetric; waitHours: number; b: Partial<Templates> } | null;
  holdoutPct: number;
  sendTimeOpt: boolean;
  templateId: string | null;
  aiDrafted: boolean;
}
export interface WizardCoupon {
  id: string;
  code: string;
  summary: string;
  unique: boolean;
  usable: boolean;
  active: boolean;
  expired: boolean;
  notStarted: boolean;
  maxedOut: boolean;
  endsOn: string | null;
  when: string | null;
  firstVisitOnly: boolean;
  maxPerCustomer: number | null;
  redemptions: number;
  revenueCents: number;
}
export interface WizardTemplate {
  id: string;
  name: string;
  campaignType: "update" | "promotion";
  description: string | null;
  channels: Channel[];
  templates: Templates;
}
type Option = { id: string; name: string };
type Preview = { matched: number; optedIn: number; byChannel: Record<Channel, number>; optedInBy: Record<Channel, number>; unreachable: number; sample: string[] };
type Kind = "update" | "promotion" | "ai";

const STEPS = ["Type", "Audience & options", "Content", "Review"] as const;
const NEW_TEMPLATES: Templates = {
  sms: `{shop}: Hi {first_name}, . Book: {book_link} ${STOP_LINE}`,
  emailSubject: "News from {shop}",
  emailBody: "Hi {first_name},\n\n\n\nBook your next cut: {book_link}",
  pushTitle: "{shop}",
  pushBody: "",
};
const PROMO_TEMPLATES: Templates = {
  sms: `{shop}: Hi {first_name}, use {coupon_code} on your next visit, good till {expiry}. Book: {book_link} ${STOP_LINE}`,
  emailSubject: "A little something from {shop}",
  emailBody: "Hi {first_name},\n\nUse {coupon_code} on your next visit, good till {expiry}.\n\nBook here: {book_link}",
  pushTitle: "An offer from {shop}",
  pushBody: "Use {coupon_code} till {expiry}.",
};
const localInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const stageOf = (seg: Segment): ClientStage | null =>
  (Object.keys(CLIENT_STAGES) as ClientStage[]).find((k) => {
    const want = { ...Object.fromEntries(STAGE_FIELDS.map((f) => [f, (EMPTY_SEGMENT as Record<string, unknown>)[f]])), ...stageSegment(k) };
    return STAGE_FIELDS.every((f) => JSON.stringify((seg as Record<string, unknown>)[f]) === JSON.stringify((want as Record<string, unknown>)[f]));
  }) ?? null;

export function BlastWizard(p: {
  blast: WizardBlast | null;
  mayEdit: boolean;
  mayWrite: boolean;
  maySend: boolean;
  everyLocation: boolean;
  shops: Option[];
  options: FilterOptions;
  sees: PanelSees;
  initialSegment?: Segment;
  initialShopIds?: string[];
  coupons: WizardCoupon[];
  library: WizardTemplate[];
  settings: { address: string; quietStart: string; quietEnd: string; capPerWeek: number; capPerMonth: number; attributionDays: number };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [step, setStep] = useState(p.blast ? (p.mayEdit ? 1 : 3) : 0);
  const [id, setId] = useState(p.blast?.id ?? null);
  const [kind, setKind] = useState<Kind>(p.blast?.campaignType ?? "update");
  const [name, setName] = useState(p.blast?.name ?? "");
  const [shopIds, setShopIds] = useState<string[]>(p.blast?.shopIds ?? (p.initialShopIds?.length ? p.initialShopIds : p.everyLocation ? [] : p.shops.map((x) => x.id)));
  const [channels, setChannels] = useState<Channel[]>(p.blast?.channels ?? ["sms", "email", "push"]);
  const [templates, setTemplates] = useState<Templates>(p.blast?.templates ?? NEW_TEMPLATES);
  const [promoId, setPromoId] = useState(p.blast?.promoId ?? null);
  const [seg, setSeg] = useState<Segment>(p.blast?.segment ?? p.initialSegment ?? EMPTY_SEGMENT);
  const [freq, setFreq] = useState<Freq>(p.blast?.recurrence?.freq ?? "once");
  const [endsOn, setEndsOn] = useState(p.blast?.recurrence?.endsOn ?? "");
  const [abOn, setAbOn] = useState(!!p.blast?.ab);
  const [ab, setAb] = useState(p.blast?.ab ?? { testPct: 20, metric: "click" as AbMetric, waitHours: 4, b: {} as Partial<Templates> });
  const [variant, setVariant] = useState<"a" | "b">("a");
  const [holdoutPct, setHoldoutPct] = useState(p.blast?.holdoutPct ?? 0);
  const [sendTimeOpt, setSendTimeOpt] = useState(p.blast?.sendTimeOpt ?? false);
  const [templateId, setTemplateId] = useState(p.blast?.templateId ?? null);
  const [aiDrafted, setAiDrafted] = useState(p.blast?.aiDrafted ?? false);
  const [prompt, setPrompt] = useState("");
  const [draftInfo, setDraftInfo] = useState<{ rationale: string; notes: string[]; drafter: string } | null>(null);
  const [when, setWhen] = useState<"now" | "later">(p.blast?.scheduledAt ? "later" : "now");
  const [at, setAt] = useState(localInput(p.blast?.scheduledAt ?? null));
  const [reviewed, setReviewed] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [counting, setCounting] = useState(false);
  const asked = useRef(0);
  const ro = !p.mayEdit || !p.mayWrite;
  const campaignType = kind === "ai" ? (promoId ? "promotion" : "update") : kind;
  const repeating = freq !== "once";
  const coupon = p.coupons.find((c) => c.id === promoId) ?? null;
  const bTemplates = variantTemplates(templates, ab.b);
  const canCount = p.mayWrite || p.maySend;

  useEffect(() => {
    if (!canCount) return;
    const n = ++asked.current;
    setCounting(true);
    const t = setTimeout(async () => {
      const r = await previewBlastAction({ segment: seg, shopIds, channels });
      if (n !== asked.current) return;
      setCounting(false);
      if (r.ok) {
        setPreview(r.data);
        setError(null);
      } else {
        setPreview(null);
        setError(r.error);
      }
    }, 400);
    return () => clearTimeout(t);
  }, [canCount, seg, shopIds, channels]);

  const input = () => ({
    id,
    name,
    channels,
    templates,
    segment: seg,
    promoId: campaignType === "promotion" ? promoId : null,
    shopIds,
    campaignType,
    recurrence: { freq, endsOn: repeating && endsOn ? endsOn : null },
    ab: abOn && !repeating ? ab : null,
    holdoutPct,
    sendTimeOpt,
    templateId,
    aiDrafted,
  });
  const persist = async (): Promise<string | null> => {
    setError(null);
    const r = await saveBlastAction(input());
    if (!r.ok) return (setError(r.error), null);
    if (!id) {
      setId(r.data.id);
      window.history.replaceState(null, "", `/admin/campaign-center/blasts/${r.data.id}`);
    }
    return r.data.id;
  };

  const stepProblem = (s: number): string | null => {
    if (s >= 1 && !name.trim()) return "Name the blast";
    if (s >= 2 && !channels.length) return "Pick at least one channel";
    if (s >= 3 && campaignType === "promotion" && !promoId) return "Pick the promotion's coupon";
    if (s >= 3 && abOn && !repeating && !abChanges(templates, ab.b).length) return "Give variant B different wording, or turn off the A/B test";
    return null;
  };
  const go = (s: number) => {
    const problem = s > step ? stepProblem(s) : null;
    if (problem) return setError(problem);
    setError(null);
    setStep(s);
  };

  const pickKind = (k: Kind) => {
    setKind(k);
    setAiDrafted(k === "ai" ? aiDrafted : aiDrafted && !!draftInfo);
    if (k === "update") setPromoId(null);
    if (!p.blast && !templateId) setTemplates(k === "promotion" ? PROMO_TEMPLATES : NEW_TEMPLATES);
  };
  const draft = () =>
    start(async () => {
      setError(null);
      const r = await draftBlastAction(prompt);
      if (!r.ok) return setError(r.error);
      const d = r.data;
      setName(d.name);
      setChannels(d.channels);
      setTemplates(d.templates);
      setSeg(d.segment);
      setPromoId(d.promoId);
      setTemplateId(null);
      setAiDrafted(true);
      setReviewed(false);
      setDraftInfo({ rationale: d.rationale, notes: d.notes, drafter: d.drafter });
      setStep(1);
    });
  const applyTemplate = (t: WizardTemplate | null) => {
    setTemplateId(t?.id ?? null);
    if (!t) return;
    setTemplates(t.templates);
    setChannels(t.channels);
    if (t.campaignType !== campaignType && kind !== "ai") setKind(t.campaignType);
  };

  const send = () =>
    start(async () => {
      setDone(null);
      if (!reviewed) return setError("Confirm you've reviewed the audience and wording");
      const n = preview ? preview.optedIn - Math.round((preview.optedIn * holdoutPct) / 100) : null;
      if (when === "now" && !confirm(n !== null ? `Send to about ${n} opted-in clients now?` : "Send this blast now?")) return;
      const saved = p.mayWrite ? await persist() : id;
      if (!saved) return;
      const r = await scheduleBlastAction(saved, when === "later" ? new Date(at).toISOString() : null, true);
      if (!r.ok) return setError(r.error);
      setDone(
        when === "later"
          ? `Scheduled for ${formatDateTime(new Date(at))}${repeating ? `, then ${FREQ_LABEL[freq].toLowerCase()}` : ""}.`
          : `Sent: ${r.data.queued} queued${r.data.skipped ? `, ${r.data.skipped} skipped (limits, consent or the holdout group)` : ""}. Messages due in quiet hours go out when they end.`,
      );
      router.refresh();
    });

  const kinds: { k: Kind; title: string; body: string }[] = [
    { k: "update", title: "Quick update", body: "News with no offer: new hours, a holiday closing, a new barber." },
    { k: "promotion", title: "Promotion", body: "An offer with one of your promo codes, checked at checkout." },
    { k: "ai", title: "Describe it", body: "Say what you want; the assistant drafts the wording and audience for you to review." },
  ];
  const stage = stageOf(seg);
  const holdoutN = preview ? Math.round((preview.optedIn * holdoutPct) / 100) : null;

  return (
    <div className="space-y-5">
      <ol className="grid grid-cols-4 gap-2" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => go(i)}
              aria-current={step === i ? "step" : undefined}
              className={cx("w-full rounded-lg px-3 py-2 text-left text-sm ring-1 ring-inset", step === i ? "bg-zinc-900 text-white ring-zinc-900" : i < step ? "bg-white text-zinc-900 ring-zinc-300" : "bg-zinc-50 text-zinc-500 ring-zinc-200")}
            >
              <span className="block text-[11px] uppercase tracking-wide opacity-70">Step {i + 1}</span>
              {label}
            </button>
          </li>
        ))}
      </ol>

      {aiDrafted && (
        <Notice tone="blue">
          The assistant drafted this blast{draftInfo ? ` (${draftInfo.drafter === "keywords" ? "keyword drafter, nothing left the server" : draftInfo.drafter})` : ""}. Check every step: nothing goes out until you confirm on Review.
          {draftInfo?.rationale && <span className="mt-1 block">{draftInfo.rationale}</span>}
          {draftInfo?.notes.map((n) => (
            <span key={n} className="mt-1 block text-xs">
              • {n}
            </span>
          ))}
        </Notice>
      )}

      {step === 0 && (
        <Card>
          <CardHeader title="What kind of blast?" />
          <div className="space-y-4 p-4">
            <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="Blast type">
              {kinds.map((x) => (
                <button
                  key={x.k}
                  type="button"
                  role="radio"
                  aria-checked={kind === x.k}
                  disabled={ro}
                  onClick={() => pickKind(x.k)}
                  data-testid={`type-${x.k}`}
                  className={cx("rounded-xl p-4 text-left ring-1 ring-inset transition", kind === x.k ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-zinc-200 hover:ring-zinc-400")}
                >
                  <div className="font-semibold text-zinc-900">{x.title}</div>
                  <div className="mt-1 text-sm text-zinc-600">{x.body}</div>
                </button>
              ))}
            </div>
            {kind === "ai" && (
              <div className="space-y-2">
                <Field label="What do you want to send?" hint="Only this sentence, your coupon codes, location names and badge names go to the assistant. Never client details.">
                  <Textarea rows={3} value={prompt} maxLength={500} onChange={(e) => setPrompt(e.target.value)} placeholder="Win back clients we haven't seen in 8 weeks with 20% off, by text" />
                </Field>
                <Button disabled={pending || prompt.trim().length < 8} onClick={draft} data-testid="ai-draft">
                  {pending ? "Drafting…" : "Draft it"}
                </Button>
              </div>
            )}
            <Field label="Name (only staff see it)">
              <Input value={name} disabled={ro} onChange={(e) => setName(e.target.value)} placeholder="Spring beard special" />
            </Field>
          </div>
        </Card>
      )}

      {step === 1 && (
        <>
          <Card>
            <CardHeader title="Who gets it" subtitle="Clients whose last visit (or home location) is at these locations, who match every filter and agreed to marketing on the channel." />
            <div className="space-y-4 p-4">
              <Field label="Locations">
                <Chips
                  disabled={ro}
                  options={[...(p.everyLocation ? [{ id: "", name: "Every location" }] : []), ...p.shops]}
                  selected={shopIds.length ? shopIds : p.everyLocation ? [""] : []}
                  onToggle={(x) => setShopIds(x === "" ? [] : toggle(shopIds, x))}
                />
              </Field>
              <Field label="Start from" hint="A starting point; narrow it with any filter below.">
                <div className="flex flex-wrap gap-2">
                  {[{ k: null as ClientStage | null, label: "Everyone", hint: "Every client at the locations" }, ...(Object.keys(CLIENT_STAGES) as ClientStage[]).map((k) => ({ k, label: CLIENT_STAGES[k].label, hint: CLIENT_STAGES[k].hint }))].map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      disabled={ro}
                      title={o.hint}
                      onClick={() => setSeg({ ...seg, ...Object.fromEntries(STAGE_FIELDS.map((f) => [f, (EMPTY_SEGMENT as Record<string, unknown>)[f]])), ...(o.k ? stageSegment(o.k) : {}) })}
                      className={cx("rounded-full px-3 py-1 text-sm ring-1 ring-inset", stage === o.k ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white text-zinc-700 ring-zinc-300 hover:ring-zinc-500")}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </Field>
              <SegmentFilters seg={seg} onChange={(x) => setSeg({ ...seg, ...x })} options={p.options} sees={p.sees} disabled={ro} campaign />
              <Field label="Channels, in the order they're tried">
                <ChannelOrder value={channels} disabled={ro} onChange={setChannels} />
              </Field>
              <AudiencePanel preview={preview} counting={counting} canCount={canCount} channels={channels} holdoutN={holdoutN} />
            </div>
          </Card>

          <Card>
            <CardHeader title="When" subtitle={`No marketing goes out ${p.settings.quietStart}–${p.settings.quietEnd} local time; messages due then wait until it ends.`} />
            <div className="grid gap-3 p-4 md:grid-cols-4">
              <Field label="Send">
                <Select value={when} disabled={!p.maySend && ro} onChange={(e) => setWhen(e.target.value as "now" | "later")}>
                  <option value="now">Now, once it&apos;s reviewed</option>
                  <option value="later">At a date and time</option>
                </Select>
              </Field>
              {when === "later" && (
                <Field label="First send (your time)">
                  <Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
                </Field>
              )}
              <Field label="Repeat" hint={repeating ? "Same weekday (or day of the month) and time as the first send" : undefined}>
                <Select
                  value={freq}
                  disabled={ro}
                  onChange={(e) => {
                    setFreq(e.target.value as Freq);
                    if (e.target.value !== "once") setAbOn(false);
                  }}
                >
                  {FREQS.map((f) => (
                    <option key={f} value={f}>
                      {FREQ_LABEL[f]}
                    </option>
                  ))}
                </Select>
              </Field>
              {repeating && (
                <Field label="Until" hint="Blank: until you pause or cancel it">
                  <Input type="date" value={endsOn} disabled={ro} onChange={(e) => setEndsOn(e.target.value)} />
                </Field>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Options" />
            <div className="space-y-4 p-4">
              <div className="rounded-lg p-3 ring-1 ring-zinc-200">
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" checked={abOn && !repeating} disabled={ro || repeating} onChange={(e) => setAbOn(e.target.checked)} data-testid="ab-toggle" />
                  <span>
                    <span className="font-medium">A/B test the wording</span>
                    <span className="block text-xs text-zinc-500">{repeating ? "For one-time blasts only." : "Two versions go to a small share each; the better one goes to everyone else automatically. You write version B in the next step."}</span>
                  </span>
                </label>
                {abOn && !repeating && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Test group" hint={`${ab.testPct / 2}% get A, ${ab.testPct / 2}% get B`}>
                      <Select value={ab.testPct} disabled={ro} onChange={(e) => setAb({ ...ab, testPct: Number(e.target.value) })}>
                        {[10, 20, 30, 40, 50].map((x) => (
                          <option key={x} value={x}>
                            {x}% of the audience
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Winner by">
                      <Select value={ab.metric} disabled={ro} onChange={(e) => setAb({ ...ab, metric: e.target.value as AbMetric })}>
                        {AB_METRICS.map((m) => (
                          <option key={m} value={m}>
                            {AB_METRIC_LABEL[m]}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Pick the winner after">
                      <Select value={ab.waitHours} disabled={ro} onChange={(e) => setAb({ ...ab, waitHours: Number(e.target.value) })}>
                        {[1, 2, 4, 8, 12, 24, 48, 72].map((h) => (
                          <option key={h} value={h}>
                            {h} hour{h === 1 ? "" : "s"}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Holdout group" hint="Eligible clients held back at random and sent nothing, so the results show what the blast really added (lift).">
                  <Select value={holdoutPct} disabled={ro} onChange={(e) => setHoldoutPct(Number(e.target.value))} data-testid="holdout">
                    {[0, 5, 10, 15, 20, 25, HOLDOUT_MAX].map((x) => (
                      <option key={x} value={x}>
                        {x ? `Hold back ${x}%` : "No holdout"}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="flex items-start gap-2 self-center text-sm">
                  <input type="checkbox" className="mt-1" checked={sendTimeOpt} disabled={ro} onChange={(e) => setSendTimeOpt(e.target.checked)} />
                  <span>
                    <span className="font-medium">Send at each client&apos;s usual booking time</span>
                    <span className="block text-xs text-zinc-500">Each message waits (up to a day) for the time of day the client usually books. Clients with fewer than two bookings get it right away.</span>
                  </span>
                </label>
              </div>
              <p className="text-xs text-zinc-500">
                Every client gets at most {p.settings.capPerWeek} marketing message{p.settings.capPerWeek === 1 ? "" : "s"} a week and {p.settings.capPerMonth} a month, all campaigns together, and nothing in quiet hours.{" "}
                <Link className="underline" href="/admin/campaign-center/settings">
                  Limits
                </Link>
              </p>
            </div>
          </Card>
        </>
      )}

      {step === 2 && (
        <>
          {campaignType === "promotion" && (
            <Card>
              <CardHeader
                title="Promo code"
                subtitle="Redemptions and revenue are from tickets the code was used on (not reversed). Expired, used-up and switched-off codes can't be picked."
                action={
                  <Link className="text-xs underline" href="/admin/promos">
                    Promos
                  </Link>
                }
              />
              <CouponList coupons={p.coupons} value={promoId} disabled={ro} onChange={setPromoId} />
            </Card>
          )}
          <Card>
            <CardHeader
              title="Message"
              action={
                p.library.length > 0 && (
                  <Select className="w-56" aria-label="Start from a brand template" disabled={ro} value={templateId ?? ""} onChange={(e) => applyTemplate(p.library.find((t) => t.id === e.target.value) ?? null)}>
                    <option value="">Start from a brand template…</option>
                    {p.library
                      .filter((t) => campaignType === "promotion" || t.campaignType === "update")
                      .map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                          {t.campaignType === "promotion" ? " (promotion)" : ""}
                        </option>
                      ))}
                  </Select>
                )
              }
            />
            <div className="space-y-4 p-4">
              {abOn && !repeating && (
                <div className="flex items-center gap-2">
                  {(["a", "b"] as const).map((v) => (
                    <button key={v} type="button" onClick={() => setVariant(v)} className={cx("rounded-full px-3 py-1 text-sm ring-1 ring-inset", variant === v ? "bg-zinc-900 text-white ring-zinc-900" : "bg-white ring-zinc-300")}>
                      Version {v.toUpperCase()}
                    </button>
                  ))}
                  {variant === "b" && <span className="text-xs text-zinc-500">Changed: {abChanges(templates, ab.b).join(", ") || "nothing yet"}</span>}
                </div>
              )}
              {variant === "b" && abOn && !repeating ? (
                <TemplateFields
                  value={bTemplates}
                  channels={channels}
                  disabled={ro}
                  address={p.settings.address}
                  onChange={(t) => setAb({ ...ab, b: Object.fromEntries((Object.keys(t) as (keyof Templates)[]).filter((k) => t[k] !== templates[k]).map((k) => [k, t[k]])) })}
                />
              ) : (
                <TemplateFields value={templates} channels={channels} disabled={ro} address={p.settings.address} onChange={setTemplates} />
              )}
              {coupon && !coupon.usable && <Notice tone="red">{coupon.code} can&apos;t be sent: it&apos;s {coupon.expired ? `expired (ended ${coupon.endsOn})` : coupon.maxedOut ? "used up" : "switched off"}.</Notice>}
            </div>
          </Card>
          <ChannelPreview templates={variant === "b" && abOn && !repeating ? bTemplates : templates} channels={channels} address={p.settings.address} />
        </>
      )}

      {step === 3 && (
        <Card>
          <CardHeader title="Review" subtitle="Check it, send yourself a test, then confirm." />
          <div className="space-y-4 p-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-zinc-500">Name</dt>
              <dd>{name || "—"}</dd>
              <dt className="text-zinc-500">Type</dt>
              <dd>
                {campaignType === "promotion" ? "Promotion" : "Quick update"}
                {aiDrafted && (
                  <Badge tone="violet" className="ml-2">
                    Drafted by the assistant
                  </Badge>
                )}
              </dd>
              <dt className="text-zinc-500">Locations</dt>
              <dd>{shopIds.length ? shopIds.map((s) => p.shops.find((x) => x.id === s)?.name ?? "Another location").join(", ") : "Every location"}</dd>
              <dt className="text-zinc-500">Audience</dt>
              <dd>
                {preview ? (
                  <>
                    {preview.optedIn} opted-in of {preview.matched} matching
                    {holdoutN ? `, about ${holdoutN} held back` : ""} · {stage ? CLIENT_STAGES[stage].label : "Custom filters"}
                  </>
                ) : (
                  "Counting…"
                )}
              </dd>
              <dt className="text-zinc-500">Channels</dt>
              <dd>{channels.map((c) => CHANNEL_LABEL[c]).join(" → ")}</dd>
              <dt className="text-zinc-500">Coupon</dt>
              <dd>{coupon ? `${coupon.code}: ${coupon.summary}${coupon.when ? ` (${coupon.when})` : ""}` : "None"}</dd>
              <dt className="text-zinc-500">When</dt>
              <dd>
                {when === "later" ? formatDateTime(new Date(at)) : "Now"}
                {repeating ? `, then ${FREQ_LABEL[freq].toLowerCase()}${endsOn ? ` until ${endsOn}` : ""}` : ""}
                {sendTimeOpt ? " · at each client's usual booking time" : ""}
              </dd>
              <dt className="text-zinc-500">A/B test</dt>
              <dd>{abOn && !repeating ? `${ab.testPct}% split A/B, winner by ${AB_METRIC_LABEL[ab.metric].toLowerCase()} after ${ab.waitHours}h · B changes ${abChanges(templates, ab.b).join(", ") || "nothing"}` : "Off"}</dd>
              <dt className="text-zinc-500">Holdout</dt>
              <dd>{holdoutPct ? `${holdoutPct}% held back to measure lift` : "None"}</dd>
              <dt className="text-zinc-500">Limits</dt>
              <dd>
                {p.settings.capPerWeek}/week, {p.settings.capPerMonth}/month per client; quiet {p.settings.quietStart}–{p.settings.quietEnd}
              </dd>
            </dl>
            {coupon && !coupon.usable && <Notice tone="red">{coupon.code} has expired or can&apos;t be used. Pick another coupon in Content.</Notice>}
            {p.mayEdit && (
              <div className="space-y-2">
                <TestSend campaignId={id} channels={channels} shops={p.shops.filter((x) => !shopIds.length || shopIds.includes(x.id))} templates={templates} beforeSend={persist} />
                {abOn && !repeating && (
                  <div className="text-xs text-zinc-500">
                    Version B:
                    <TestSend campaignId={id} channels={channels} shops={p.shops.filter((x) => !shopIds.length || shopIds.includes(x.id)).slice(0, 1)} templates={bTemplates} beforeSend={persist} />
                  </div>
                )}
              </div>
            )}
            {p.mayEdit && p.maySend && (
              <label className="flex items-start gap-2 rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200">
                <input type="checkbox" className="mt-1" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} data-testid="reviewed" />
                <span>
                  I&apos;ve checked the audience, wording{campaignType === "promotion" ? ", coupon" : ""} and timing{aiDrafted ? ", including everything the assistant drafted" : ""}.
                </span>
              </label>
            )}
          </div>
        </Card>
      )}

      {error && <Notice tone="red">{error}</Notice>}
      {done && <Notice tone="green">{done}</Notice>}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {step > 0 && (
            <Button variant="secondary" onClick={() => go(step - 1)}>
              Back
            </Button>
          )}
          {p.mayEdit && p.mayWrite && (
            <Button
              variant="ghost"
              disabled={pending || !name.trim()}
              onClick={() =>
                start(async () => {
                  setDone(null);
                  if (await persist()) setDone("Saved as a draft.");
                })
              }
            >
              Save draft
            </Button>
          )}
          {p.mayEdit && id && (p.blast?.status === "scheduled" || p.blast?.status === "paused" ? p.maySend : p.mayWrite) && (
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  if (!confirm(p.blast?.status === "draft" || !p.blast ? "Discard this draft?" : "Cancel this blast? It won't go out again.")) return;
                  const r = await cancelBlastAction(id);
                  if (!r.ok) return setError(r.error);
                  router.push("/admin/campaign-center/blasts");
                })
              }
            >
              {p.blast?.status === "scheduled" || p.blast?.status === "paused" ? "Cancel blast" : "Discard"}
            </Button>
          )}
        </div>
        {step < 3 ? (
          <Button onClick={() => go(step + 1)} disabled={kind === "ai" && step === 0 && !aiDrafted} data-testid="next">
            Next: {STEPS[step + 1]}
          </Button>
        ) : p.mayEdit && p.maySend ? (
          <Button disabled={pending || !reviewed || (coupon !== null && !coupon.usable)} onClick={send} data-testid="send-now">
            {when === "later" ? "Schedule" : "Send now"}
          </Button>
        ) : p.mayEdit ? (
          <span className="text-sm text-zinc-500">Someone with Campaign Center: send reviews and sends it.</span>
        ) : null}
      </div>
    </div>
  );
}

function AudiencePanel({ preview, counting, canCount, channels, holdoutN }: { preview: Preview | null; counting: boolean; canCount: boolean; channels: Channel[]; holdoutN: number | null }) {
  if (!canCount) return <p className="text-sm text-zinc-500">Counts only, for people who create or send. Contact details never show here.</p>;
  return (
    <div className={cx("rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200", counting && "opacity-70")} data-testid="blast-preview" aria-live="polite" aria-busy={counting}>
      {preview ? (
        <div className="space-y-3">
          <div className="text-sm">
            <strong className="text-base" data-testid="opted-in-count">
              {preview.optedIn}
            </strong>{" "}
            opted-in client{preview.optedIn === 1 ? "" : "s"} would get it · {preview.matched} match the filters · {preview.unreachable} haven&apos;t agreed to any of these channels
            {holdoutN ? ` · about ${holdoutN} held back` : ""}
            {preview.sample.length > 0 && <span className="text-zinc-500"> · e.g. {preview.sample.join(", ")}</span>}
          </div>
          <div className="grid grid-cols-3 gap-2" data-testid="opted-in-by-channel">
            {CHANNELS.map((c) => (
              <div key={c} className={cx("rounded-lg bg-white p-2 ring-1 ring-zinc-200", !channels.includes(c) && "opacity-50")}>
                <div className="text-[11px] uppercase tracking-wide text-zinc-500">{CHANNEL_LABEL[c]} opted in</div>
                <div className="tabular text-lg font-semibold">{preview.optedInBy[c]}</div>
                <div className="text-[11px] text-zinc-500">{channels.includes(c) ? `${preview.byChannel[c]} get it by ${CHANNEL_LABEL[c].toLowerCase()}` : "Not used"}</div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2" aria-label="Counting">
          {CHANNELS.map((c) => (
            <div key={c} className="h-16 animate-pulse rounded-lg bg-zinc-200/70" />
          ))}
        </div>
      )}
    </div>
  );
}

function CouponList({ coupons, value, onChange, disabled }: { coupons: WizardCoupon[]; value: string | null; onChange: (id: string | null) => void; disabled: boolean }) {
  if (!coupons.length)
    return (
      <div className="p-4 text-sm text-zinc-600">
        No promo codes yet.{" "}
        <Link className="underline" href="/admin/promos">
          Create one in Promos
        </Link>
        , then come back.
      </div>
    );
  const sorted = [...coupons].sort((a, b) => Number(b.usable) - Number(a.usable) || a.code.localeCompare(b.code));
  return (
    <div className="divide-y divide-zinc-100" role="radiogroup" aria-label="Promo code" data-testid="coupon-list">
      <div className="px-4 py-2 text-xs text-zinc-500">
        {coupons.filter((c) => c.usable).length} of {coupons.length} codes can be used
      </div>
      {sorted.map((c) => {
        const why = !c.active ? "Switched off" : c.expired ? `Expired ${c.endsOn}` : c.maxedOut ? "Used up" : null;
        return (
          <label key={c.id} className={cx("flex cursor-pointer items-center gap-3 px-4 py-2 text-sm", !c.usable && "cursor-not-allowed bg-zinc-50 text-zinc-500", value === c.id && "bg-brand-50")}>
            <input type="radio" name="coupon" checked={value === c.id} disabled={disabled || (!c.usable && value !== c.id)} onChange={() => onChange(c.id)} />
            <span className="min-w-0 flex-1">
              <span className="font-mono font-semibold">{c.unique ? `${c.code}-…` : c.code}</span> <span>{c.summary}</span>
              <span className="mt-0.5 flex flex-wrap gap-1">
                {why && <Badge tone="red">{why}</Badge>}
                {c.notStarted && <Badge tone="amber">Not started yet</Badge>}
                {c.endsOn && !c.expired && <Badge>Ends {c.endsOn}</Badge>}
                {c.when && <Badge tone="amber">{c.when}</Badge>}
                {c.firstVisitOnly && <Badge>First visit only</Badge>}
                <Badge>{c.maxPerCustomer === 1 ? "One time per client" : c.maxPerCustomer ? `Up to ${c.maxPerCustomer} per client` : "Recurring"}</Badge>
                {c.unique && <Badge tone="violet">Single-use codes</Badge>}
              </span>
            </span>
            <span className="tabular text-right text-xs">
              <span className="block font-semibold text-zinc-900">{c.redemptions} redeemed</span>
              {formatCents(c.revenueCents)} revenue
            </span>
          </label>
        );
      })}
    </div>
  );
}
