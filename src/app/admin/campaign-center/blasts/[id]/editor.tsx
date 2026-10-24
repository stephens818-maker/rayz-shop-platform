"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Chips, toggle } from "@/components/chips";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, cx } from "@/components/ui";
import { CHANNELS, CHANNEL_LABEL, Channel, EMPTY_SEGMENT, STOP_LINE, Segment, Templates } from "@/domain/marketing";
import { formatDateTime } from "@/lib/time";
import { cancelBlastAction, previewBlastAction, saveBlastAction, scheduleBlastAction } from "../../actions";
import { SegmentFilters } from "@/components/segment-filters";
import type { FilterOptions, PanelSees } from "@/domain/client-filters";
import { ChannelOrder, TemplateFields } from "../../template-fields";
import { TestSend } from "../../test-send";

interface Blast {
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
}
type Option = { id: string; name: string };
type Preview = { matched: number; optedIn: number; byChannel: Record<Channel, number>; unreachable: number; sample: string[] };

const NEW_TEMPLATES: Templates = {
  sms: `{shop}: Hi {first_name}, `,
  emailSubject: "News from {shop}",
  emailBody: "Hi {first_name},\n\n\n\nBook your next cut: {book_link}",
  pushTitle: "{shop}",
  pushBody: "",
};
const localInput = (iso: string | null) => {
  const d = iso ? new Date(iso) : new Date(Date.now() + 3_600_000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function BlastEditor(p: {
  blast: Blast | null;
  /** In their scope and not sent yet. */
  mayEdit: boolean;
  /** Campaign Center: create. */
  mayWrite: boolean;
  /** Campaign Center: send. */
  maySend: boolean;
  everyLocation: boolean;
  shops: Option[];
  options: FilterOptions;
  sees: PanelSees;
  /** A new blast from a client list search: its filters. */
  initialSegment?: Segment;
  coupons: { id: string; code: string; summary: string; unique: boolean }[];
  address: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [id, setId] = useState(p.blast?.id ?? null);
  const [name, setName] = useState(p.blast?.name ?? "");
  const [shopIds, setShopIds] = useState<string[]>(p.blast?.shopIds ?? (p.everyLocation ? [] : p.shops.map((x) => x.id)));
  const [channels, setChannels] = useState<Channel[]>(p.blast?.channels ?? ["sms", "email", "push"]);
  const [templates, setTemplates] = useState<Templates>(p.blast?.templates ?? { ...NEW_TEMPLATES, sms: `${NEW_TEMPLATES.sms} Book: {book_link} ${STOP_LINE}` });
  const [promoId, setPromoId] = useState(p.blast?.promoId ?? null);
  const [seg, setSeg] = useState<Segment>(p.blast?.segment ?? p.initialSegment ?? EMPTY_SEGMENT);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [counting, setCounting] = useState(false);
  const asked = useRef(0);
  const [at, setAt] = useState(localInput(p.blast?.scheduledAt ?? null));
  const ro = !p.mayEdit || !p.mayWrite;
  const s = (x: Partial<Segment>) => setSeg({ ...seg, ...x });
  const input = () => ({ id, name, channels, templates, segment: seg, promoId, shopIds });
  const canCount = p.mayWrite || p.maySend;

  // The count follows the filters as they change, a moment after the last change.
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
  const send = (when: string | null) =>
    start(async () => {
      setDone(null);
      if (!when && !confirm(preview ? `Send to ${preview.optedIn} opted-in clients now?` : "Send this blast now?")) return;
      const saved = p.mayWrite ? await persist() : id;
      if (!saved) return;
      const r = await scheduleBlastAction(saved, when ? new Date(when).toISOString() : null);
      if (!r.ok) return setError(r.error);
      setDone(
        when
          ? `Scheduled for ${formatDateTime(new Date(when))}.`
          : `Sent: ${r.data.queued} queued${r.data.skipped ? `, ${r.data.skipped} skipped (limits or consent)` : ""}. Messages due in quiet hours go out when they end.`,
      );
      router.refresh();
    });

  const sent = p.blast && !["draft", "scheduled"].includes(p.blast.status);
  return (
    <>
      {p.blast && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <Badge tone={p.blast.status === "sent" ? "green" : p.blast.status === "scheduled" ? "blue" : p.blast.status === "cancelled" ? "red" : "gray"}>{p.blast.status}</Badge>
          {p.blast.sentAt && (
            <span>
              Sent {formatDateTime(p.blast.sentAt)} to {p.blast.sent} clients
            </span>
          )}
          {p.blast.status === "scheduled" && p.blast.scheduledAt && <span>Goes out {formatDateTime(p.blast.scheduledAt)}</span>}
        </div>
      )}
      <Card>
        <CardHeader title="Message" />
        <div className="space-y-4 p-4">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="Name (only staff see it)">
              <Input value={name} disabled={ro} onChange={(e) => setName(e.target.value)} placeholder="Spring beard special" />
            </Field>
            <Field label="Coupon">
              <Select value={promoId ?? ""} disabled={ro} onChange={(e) => setPromoId(e.target.value || null)}>
                <option value="">No coupon</option>
                {p.coupons.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code}: {c.summary}
                    {c.unique ? " (single-use codes)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Channels, in the order they're tried">
            <ChannelOrder value={channels} disabled={ro} onChange={setChannels} />
          </Field>
          <TemplateFields value={templates} channels={channels} disabled={ro} address={p.address} onChange={setTemplates} />
          {p.mayEdit && <TestSend campaignId={id} channels={channels} shops={p.shops.filter((x) => !shopIds.length || shopIds.includes(x.id))} templates={templates} beforeSend={persist} />}
        </div>
      </Card>

      <Card>
        <CardHeader title="Who gets it" subtitle="Clients whose last visit (or home location) is at these locations, who match every filter you set and agreed to marketing." />
        <div className="space-y-4 p-4">
          <Field label="Locations">
            <Chips
              disabled={ro}
              options={[...(p.everyLocation ? [{ id: "", name: "Every location" }] : []), ...p.shops]}
              selected={shopIds.length ? shopIds : p.everyLocation ? [""] : []}
              onToggle={(x) => setShopIds(x === "" ? [] : toggle(shopIds, x))}
            />
          </Field>
          <SegmentFilters seg={seg} onChange={s} options={p.options} sees={p.sees} disabled={ro} campaign />
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200" data-testid="blast-preview" aria-live="polite">
            {!canCount ? (
              <span className="text-sm text-zinc-500">Counts only, for people who create or send. Contact details never show here.</span>
            ) : preview ? (
              <span className={cx("text-sm", counting && "opacity-60")}>
                <strong className="text-base" data-testid="opted-in-count">
                  {preview.optedIn}
                </strong>{" "}
                opted-in client{preview.optedIn === 1 ? "" : "s"} would get it · {preview.matched} match the filters ·{" "}
                {CHANNELS.filter((c) => channels.includes(c))
                  .map((c) => `${preview.byChannel[c]} by ${CHANNEL_LABEL[c].toLowerCase()}`)
                  .join(", ")}{" "}
                · {preview.unreachable} haven&apos;t agreed to any of these channels
                {preview.sample.length > 0 && <span className="text-zinc-500"> · e.g. {preview.sample.join(", ")}</span>}
              </span>
            ) : (
              <span className="text-sm text-zinc-500">{counting ? "Counting…" : "Counts only. Contact details never show here."}</span>
            )}
          </div>
        </div>
      </Card>

      {error && <Notice tone="red">{error}</Notice>}
      {done && <Notice tone="green">{done}</Notice>}
      {p.mayEdit && (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex gap-2">
            {p.mayWrite && (
              <Button
                variant="secondary"
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
            {id && (p.blast?.status === "scheduled" ? p.maySend : p.mayWrite) && (
              <Button
                variant="danger"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await cancelBlastAction(id);
                    if (!r.ok) return setError(r.error);
                    router.push("/admin/campaign-center/blasts");
                  })
                }
              >
                {p.blast?.status === "scheduled" ? "Cancel blast" : "Discard"}
              </Button>
            )}
          </div>
          {p.maySend ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Send at (your time)">
                <Input type="datetime-local" className="w-56" value={at} onChange={(e) => setAt(e.target.value)} />
              </Field>
              <Button variant="secondary" disabled={pending || !name.trim() || !at} onClick={() => send(at)}>
                Schedule
              </Button>
              <Button disabled={pending || !name.trim()} onClick={() => send(null)} data-testid="send-now">
                Send now
              </Button>
            </div>
          ) : (
            <span className="text-sm text-zinc-500">Someone with Campaign Center: send schedules or sends it.</span>
          )}
        </div>
      )}
      {sent && <p className="text-sm text-zinc-500">This blast went out, so it can&apos;t be changed. See how it did in the Campaign Center report.</p>}
    </>
  );
}
