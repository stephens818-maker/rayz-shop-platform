"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Chips, toggle } from "@/components/chips";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, cx } from "@/components/ui";
import { Channel, DEFAULT_LAPSED_STEPS, SEQUENCE_MAX_STEPS, SequenceAudience, Templates, stepLabel } from "@/domain/marketing";
import { deleteSequenceAction, previewSequenceAction, saveSequenceAction, setSequenceEnabledAction } from "../../actions";
import { BarberFilter } from "../../segment-fields";
import { ChannelOrder, TemplateFields } from "../../template-fields";
import { TestSend } from "../../test-send";

type Option = { id: string; name: string };
type Coupon = { id: string; code: string; summary: string; unique: boolean };
interface Step {
  /** Saved steps keep their id, so clients who got a step don't get it again after an edit. */
  id: string | null;
  key: string;
  afterDays: number;
  templates: Templates;
  promoId: string | null;
}
interface Sequence {
  id: string;
  name: string;
  enabled: boolean;
  channels: Channel[];
  shopIds: string[];
  audience: SequenceAudience;
  stopAfterDays: number;
  steps: { id: string; afterDays: number; templates: Templates; promoId: string | null; sent30: number }[];
}
type Preview = { steps: { afterDays: number; label: string; matched: number; optedIn: number; due: number }[]; matched: number; optedIn: number; due: number; sample: string[] };

const newKey = () => Math.random().toString(36).slice(2);

export function SequenceEditor(p: {
  sequence: Sequence | null;
  /** In their scope. */
  mayEdit: boolean;
  /** Campaign Center: create. */
  mayWrite: boolean;
  /** Campaign Center: send. */
  maySwitch: boolean;
  everyLocation: boolean;
  shops: Option[];
  barbers: Option[];
  coupons: Coupon[];
  address: string;
  seesPreferred: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [id, setId] = useState(p.sequence?.id ?? null);
  const [enabled, setEnabled] = useState(p.sequence?.enabled ?? false);
  const [name, setName] = useState(p.sequence?.name ?? "Lapsed regulars");
  const [channels, setChannels] = useState<Channel[]>(p.sequence?.channels ?? ["sms", "email", "push"]);
  const [shopIds, setShopIds] = useState<string[]>(p.sequence?.shopIds ?? (p.everyLocation ? [] : p.shops.map((x) => x.id)));
  const [audience, setAudience] = useState<SequenceAudience>(p.sequence?.audience ?? { staffIds: [], barberMatch: p.seesPreferred ? "primary" : "recent" });
  const [stopAfterDays, setStop] = useState(p.sequence?.stopAfterDays ?? 120);
  const [steps, setSteps] = useState<Step[]>(
    p.sequence?.steps.map((x) => ({ ...x, key: x.id })) ?? DEFAULT_LAPSED_STEPS.map((x) => ({ id: null, key: newKey(), afterDays: x.afterDays, templates: { ...x.templates }, promoId: null })),
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [counting, setCounting] = useState(false);
  const asked = useRef(0);
  const ro = !p.mayEdit || !p.mayWrite;
  const setStep = (key: string, x: Partial<Step>) => setSteps(steps.map((s) => (s.key === key ? { ...s, ...x } : s)));
  const ordered = [...steps].sort((a, b) => a.afterDays - b.afterDays);
  const input = () => ({ id, name, channels, shopIds, audience, settings: { stopAfterDays }, steps: ordered.map(({ id, afterDays, templates, promoId }) => ({ id, afterDays, templates, promoId })) });
  const stepKey = JSON.stringify(ordered.map((s) => [s.id, s.afterDays]));

  useEffect(() => {
    if (!p.mayWrite && !p.maySwitch) return;
    const n = ++asked.current;
    setCounting(true);
    const t = setTimeout(async () => {
      const r = await previewSequenceAction({ id, shopIds, channels, audience, settings: { stopAfterDays }, steps: JSON.parse(stepKey).map(([sid, afterDays]: [string | null, number]) => ({ id: sid, afterDays })) });
      if (n !== asked.current) return;
      setCounting(false);
      setPreview(r.ok ? r.data : null);
      if (!r.ok) setError(r.error);
    }, 400);
    return () => clearTimeout(t);
  }, [p.mayWrite, p.maySwitch, id, shopIds, channels, audience, stopAfterDays, stepKey]);

  const persist = async (): Promise<string | null> => {
    setError(null);
    const r = await saveSequenceAction(input());
    if (!r.ok) return (setError(r.error), null);
    if (!id) {
      setId(r.data.id);
      window.history.replaceState(null, "", `/admin/campaign-center/sequences/${r.data.id}`);
    }
    return r.data.id;
  };
  const lastWeeks = ordered.length ? ordered[ordered.length - 1].afterDays : 0;

  return (
    <>
      <Card>
        <CardHeader
          title="Sequence"
          subtitle="Each lapsed client gets the step for how long it's been since their last visit, once per lapse, signed by their barber with a link to book with them. They leave the sequence as soon as they book."
          action={
            id && (
              <label className="flex items-center gap-2 text-sm" data-testid="sequence-on">
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={!p.maySwitch || !p.mayEdit || pending}
                  onChange={(e) =>
                    start(async () => {
                      const next = e.target.checked;
                      const r = await setSequenceEnabledAction(id, next);
                      if (!r.ok) return setError(r.error);
                      setEnabled(next);
                      setDone(next ? "On. It goes out on the next run, every 15 minutes, outside quiet hours." : "Off. Nothing more goes out.");
                      router.refresh();
                    })
                  }
                />
                <Badge tone={enabled ? "green" : "gray"}>{enabled ? "On" : "Off"}</Badge>
              </label>
            )
          }
        />
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name (only staff see it)">
              <Input value={name} disabled={ro} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Stop after (days since the last visit)" hint="Nobody whose last visit is older than this hears from the sequence, so turning it on doesn't text every client who left years ago.">
              <Input type="number" min={14} max={730} value={stopAfterDays} disabled={ro} onChange={(e) => setStop(Number(e.target.value) || 0)} />
            </Field>
          </div>
          <Field label="Channels, in the order they're tried">
            <ChannelOrder value={channels} disabled={ro} onChange={setChannels} />
          </Field>
          <Field label="Locations">
            <Chips
              disabled={ro}
              options={[...(p.everyLocation ? [{ id: "", name: "Every location" }] : []), ...p.shops]}
              selected={shopIds.length ? shopIds : p.everyLocation ? [""] : []}
              onToggle={(x) => setShopIds(x === "" ? [] : toggle(shopIds, x))}
            />
          </Field>
          <BarberFilter
            seg={audience}
            barbers={p.barbers}
            modes={["primary", "recent"]}
            disabled={ro}
            seesPreferred={p.seesPreferred}
            onChange={(x) => setAudience({ ...audience, ...(x as Partial<SequenceAudience>) })}
          />
        </div>
      </Card>

      <div className="rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-200" data-testid="sequence-preview" aria-live="polite">
        {!p.mayWrite && !p.maySwitch ? (
          <span className="text-sm text-zinc-500">Counts are for people who create or send.</span>
        ) : preview ? (
          <div className={cx("space-y-2", counting && "opacity-60")}>
            <div className="text-sm">
              <strong className="text-base" data-testid="sequence-opted-in">
                {preview.optedIn}
              </strong>{" "}
              opted-in lapsed clients in the sequence now · {preview.matched} lapsed in its window · <strong>{preview.due}</strong> due a message on the next run
              {preview.sample.length > 0 && <span className="text-zinc-500"> · e.g. {preview.sample.join(", ")}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              {preview.steps.map((s) => (
                <span key={s.afterDays} className="rounded-lg bg-white px-3 py-1.5 text-xs ring-1 ring-zinc-200">
                  <span className="font-semibold">{s.label}</span>: {s.optedIn} opted in of {s.matched} · {s.due} due
                </span>
              ))}
            </div>
          </div>
        ) : (
          <span className="text-sm text-zinc-500">{counting ? "Counting…" : "Counts only. Contact details never show here."}</span>
        )}
      </div>

      {ordered.map((st, i) => (
        <Card key={st.key} data-testid={`step-${i + 1}`}>
          <CardHeader
            title={`Step ${i + 1} · ${stepLabel(st.afterDays, i === ordered.length - 1)}`}
            subtitle={
              i === ordered.length - 1
                ? `From ${st.afterDays} days after the last visit until the sequence stops at ${stopAfterDays}.`
                : `From ${st.afterDays} days after the last visit until step ${i + 2} at ${ordered[i + 1].afterDays}.`
            }
            action={
              !ro &&
              ordered.length > 1 && (
                <Button variant="secondary" size="sm" onClick={() => setSteps(steps.filter((x) => x.key !== st.key))}>
                  Remove step
                </Button>
              )
            }
          />
          <div className="space-y-4 p-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="Days after the last visit" hint={st.afterDays % 7 === 0 ? `${st.afterDays / 7} weeks` : undefined}>
                <Input type="number" min={7} max={365} value={st.afterDays} disabled={ro} onChange={(e) => setStep(st.key, { afterDays: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Coupon" hint={p.coupons.find((c) => c.id === st.promoId)?.unique ? "Each client gets their own single-use code." : "Optional. Add one in Promos to offer a discount."}>
                <Select value={st.promoId ?? ""} disabled={ro} onChange={(e) => setStep(st.key, { promoId: e.target.value || null })}>
                  <option value="">No coupon</option>
                  {p.coupons.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code}: {c.summary}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <TemplateFields value={st.templates} channels={channels} disabled={ro} address={p.address} onChange={(templates) => setStep(st.key, { templates })} />
            {p.mayEdit && (p.mayWrite || p.maySwitch) && <TestSend campaignId={id} channels={channels} shops={p.shops.filter((x) => !shopIds.length || shopIds.includes(x.id))} templates={st.templates} promoId={st.promoId} beforeSend={p.mayWrite ? persist : undefined} />}
          </div>
        </Card>
      ))}

      {error && <Notice tone="red">{error}</Notice>}
      {done && <Notice tone="green">{done}</Notice>}
      {!ro && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={steps.length >= SEQUENCE_MAX_STEPS}
              onClick={() => setSteps([...steps, { id: null, key: newKey(), afterDays: Math.min(365, lastWeeks + 14), templates: { ...DEFAULT_LAPSED_STEPS[1].templates }, promoId: null }])}
            >
              Add step
            </Button>
            {id && (
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    if (!confirm("Delete this sequence? What it sent stays in the report.")) return;
                    const r = await deleteSequenceAction(id);
                    if (!r.ok) return setError(r.error);
                    router.push("/admin/campaign-center");
                  })
                }
              >
                Delete
              </Button>
            )}
          </div>
          <Button
            disabled={pending || !name.trim()}
            data-testid="save-sequence"
            onClick={() =>
              start(async () => {
                setDone(null);
                if (await persist()) {
                  setDone(enabled ? "Saved. The next run uses it." : "Saved. Switch it on when you're ready.");
                  router.refresh();
                }
              })
            }
          >
            Save sequence
          </Button>
        </div>
      )}
      {p.mayEdit && !p.mayWrite && <p className="text-sm text-zinc-500">Someone with Campaign Center: create changes the wording and steps.</p>}
    </>
  );
}
