"use client";

import { useState } from "react";
import { cx } from "@/components/ui";
import { marketingEmailHtml } from "@/domain/marketing-email";
import { CHANNEL_LABEL, SAMPLE_VALUES, render, type Channel, type Templates } from "@/domain/marketing";

const BRAND = "Ray'z Barber Shop";

function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; name: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cx("rounded-md px-2.5 py-1 font-medium", value === o.id ? "bg-white text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900")}
        >
          {o.name}
        </button>
      ))}
    </div>
  );
}

/** What each client would see, filled in with sample values: the email in light or dark mode at desktop or phone width, the text, and the push. */
export function ChannelPreview({ templates, channels, address }: { templates: Templates; channels: Channel[]; address: string }) {
  const [tab, setTab] = useState<Channel>(channels[0] ?? "sms");
  const [scheme, setScheme] = useState<"light" | "dark">("light");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const ch = channels.includes(tab) ? tab : (channels[0] ?? "sms");
  const r = render(templates, SAMPLE_VALUES, { brand: BRAND, address: address || "(the brand's postal address)", unsubscribeUrl: "https://rayz.example/m/…/unsubscribe" });
  return (
    <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-200" data-testid="channel-preview">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Toggle label="Preview channel" value={ch} options={channels.map((c) => ({ id: c, name: CHANNEL_LABEL[c] }))} onChange={setTab} />
        {ch === "email" && (
          <div className="flex gap-2">
            <Toggle
              label="Color scheme"
              value={scheme}
              options={[
                { id: "light", name: "Light" },
                { id: "dark", name: "Dark" },
              ]}
              onChange={setScheme}
            />
            <Toggle
              label="Screen"
              value={width}
              options={[
                { id: "desktop", name: "Web" },
                { id: "mobile", name: "Mobile" },
              ]}
              onChange={setWidth}
            />
          </div>
        )}
      </div>
      {ch === "email" && (
        <div className={cx("mx-auto overflow-hidden rounded-lg bg-white ring-1 ring-zinc-200", width === "mobile" ? "max-w-[375px]" : "max-w-[640px]")}>
          <div className="border-b border-zinc-100 px-3 py-2 text-xs text-zinc-600">
            <div>
              <span className="text-zinc-400">From</span> {BRAND}
            </div>
            <div className="font-semibold text-zinc-900">{r.email.subject || "(no subject)"}</div>
          </div>
          <iframe title={`Email preview, ${scheme} mode, ${width}`} sandbox="" className="block h-[460px] w-full" srcDoc={marketingEmailHtml({ subject: r.email.subject, body: r.email.body, scheme })} />
        </div>
      )}
      {ch === "sms" && (
        <div className="mx-auto max-w-[320px] rounded-[2rem] bg-zinc-900 p-3 shadow-lg">
          <div className="rounded-[1.5rem] bg-white px-3 pb-6 pt-4">
            <div className="mb-3 text-center text-[11px] text-zinc-400">Text message · now</div>
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-bl-sm bg-zinc-200 px-3 py-2 text-sm text-zinc-900">{r.sms}</div>
            <div className="mt-2 text-[11px] text-zinc-400">{r.sms.length} characters</div>
          </div>
        </div>
      )}
      {ch === "push" && (
        <div className="mx-auto max-w-[360px] rounded-[2rem] bg-gradient-to-b from-zinc-700 to-zinc-900 p-4 shadow-lg">
          <div className="mb-6 mt-2 text-center text-3xl font-light text-white/90">9:41</div>
          <div className="rounded-2xl bg-white/85 p-3 backdrop-blur">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wide text-zinc-500">
              <span className="grid h-4 w-4 place-items-center rounded bg-brand-600 text-[8px] font-black text-white">RZ</span>
              Ray&apos;z · now
            </div>
            <div className="mt-1 text-sm font-semibold text-zinc-900">{r.push.title}</div>
            <div className="text-sm text-zinc-800">{r.push.body}</div>
          </div>
        </div>
      )}
    </div>
  );
}
