"use client";

import { useState, useTransition } from "react";
import { Button, Select } from "@/components/ui";
import { CHANNEL_LABEL, Channel, Templates } from "@/domain/marketing";
import { sendTestAction } from "./actions";

/** Sends this wording to the person's own phone, email or app, marked as a test and left out of the report. */
export function TestSend({
  campaignId,
  channels,
  shops,
  templates,
  promoId,
  beforeSend,
}: {
  campaignId: string | null;
  channels: Channel[];
  shops: { id: string; name: string }[];
  templates: Templates;
  /** A sequence step's coupon. */
  promoId?: string | null;
  beforeSend?: () => Promise<string | null>;
}) {
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState<Channel>(channels[0] ?? "sms");
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ch = channels.includes(channel) ? channel : channels[0];
  if (!shops.length || !ch) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-zinc-600">Send me a test by</span>
      <Select className="w-auto" value={ch} onChange={(e) => setChannel(e.target.value as Channel)} aria-label="Test channel">
        {channels.map((c) => (
          <option key={c} value={c}>
            {CHANNEL_LABEL[c]}
          </option>
        ))}
      </Select>
      {shops.length > 1 && (
        <>
          <span className="text-zinc-600">as</span>
          <Select className="w-auto" value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Test location">
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        data-testid="test-send"
        onClick={() =>
          start(async () => {
            setMsg(null);
            const id = beforeSend ? await beforeSend() : campaignId;
            if (!id) return;
            const r = await sendTestAction({ campaignId: id, shopId, channel: ch, templates, ...(promoId !== undefined ? { promoId } : {}) });
            setMsg(r.ok ? { ok: true, text: `Test sent to ${r.data.to}` } : { ok: false, text: r.error });
          })
        }
      >
        Send test
      </Button>
      {msg && <span className={msg.ok ? "text-emerald-700" : "text-red-700"}>{msg.text}</span>}
    </div>
  );
}
