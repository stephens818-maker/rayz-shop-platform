"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { SyncMsg, useSettingSync } from "@/components/brand-sync";
import { CLOCK_METHODS, METHOD_LABEL, type ClockMethod, type ShopClockSettings } from "@/domain/time-clock";
import { revokeDeviceAction, startPairingAction } from "../clock/actions";
import { nfcTagAction, saveShopClockAction } from "./actions";

type RulesInput = { unpaidBreakFromMinutes: number; autoMealMinutes: number; autoMealAfterHours: number; forgotOutAfterMinutes: number; maxShiftHours: number; graceMinutes: number; mapping: string };

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

function Saved({ ok, error }: { ok: boolean; error: string | null }) {
  if (error) return <span className="text-xs text-red-700">{error}</span>;
  return ok ? <span className="text-xs text-emerald-700">Saved.</span> : null;
}

export function RulesForm({ initial, fields }: { initial: RulesInput; fields: { key: string; label: string }[] }) {
  const { pending, msg, saveSetting, dialog } = useSettingSync("time_clock");
  const [v, setV] = useState(Object.fromEntries(Object.entries(initial).map(([k, x]) => [k, String(x)])) as Record<keyof RulesInput, string>);
  const set = (k: keyof RulesInput) => (e: { target: { value: string } }) => setV({ ...v, [k]: e.target.value });
  const n = (k: keyof RulesInput, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" min={0} value={v[k]} onChange={set(k)} className="w-28" />
    </Field>
  );
  return (
    <form
      className="space-y-4 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        saveSetting({
          unpaidBreakFromMinutes: num(v.unpaidBreakFromMinutes),
          autoMealMinutes: num(v.autoMealMinutes),
          autoMealAfterHours: num(v.autoMealAfterHours),
          forgotOutAfterMinutes: num(v.forgotOutAfterMinutes),
          maxShiftHours: num(v.maxShiftHours),
          graceMinutes: num(v.graceMinutes),
          mapping: v.mapping,
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        {n("unpaidBreakFromMinutes", "Breaks this long are unpaid (min)", "Shorter breaks are paid rest breaks. 0 makes every break unpaid.")}
        {n("autoMealMinutes", "Automatic meal deduction (min)", "Taken off a long shift with no unpaid break punched. 0 = off.")}
        {n("autoMealAfterHours", "…on shifts longer than (h)")}
        {n("graceMinutes", "Grace minutes", "Early or late by more than this is flagged. Shops can override.")}
        {n("forgotOutAfterMinutes", "Forgotten clock-out after (min past the scheduled end)")}
        {n("maxShiftHours", "…or, with no schedule, after (h on the clock)")}
      </div>
      <div id="export">
        <Field label="iSolved import columns" hint={`One column per line, "Header = field", in order. Fields: ${fields.map((f) => `${f.key} (${f.label})`).join(", ")}.`}>
          <Textarea rows={10} value={v.mapping} onChange={set("mapping")} className="font-mono text-xs" />
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button disabled={pending}>Save rules</Button>
        <SyncMsg msg={msg} />
      </div>
      {dialog}
    </form>
  );
}

const METHOD_TEXT: Record<ClockMethod, string> = {
  device: "From a registered shop device",
  gps: "Within the geofence (phone GPS)",
  network: "From the shop's network (Wi-Fi / IP)",
  qr: "By scanning the front-desk clock's QR code",
  nfc: "By tapping the shop's NFC tag",
};

/** The link to write to an NFC sticker at the shop, and retiring it when a sticker is lost or copied. */
function NfcTag({ shopId }: { shopId: string }) {
  const { pending, error, run } = useAction();
  const [url, setUrl] = useState<string | null>(null);
  return (
    <div className="rounded-lg bg-zinc-50 p-3 text-xs ring-1 ring-zinc-200">
      <div className="mb-1 font-medium text-zinc-700">NFC tag</div>
      {url ? (
        <code className="block break-all rounded bg-white p-2 ring-1 ring-zinc-200" data-testid="nfc-url">
          {url}
        </code>
      ) : (
        <p className="text-zinc-600">Write the tag&apos;s link to an NFC sticker (any NFC writer app) and stick it by the front desk. Tapping it opens the clock with the shop proven.</p>
      )}
      <div className="mt-2 flex items-center gap-3">
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => nfcTagAction(shopId), (r) => setUrl(r.url))}>
          Show the tag&apos;s link
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => confirm("Retire this shop's NFC tag? Every sticker written before stops working; write the new link to a sticker.") && run(() => nfcTagAction(shopId, true), (r) => setUrl(r.url))}
        >
          Retire and make a new link
        </Button>
        {error && <span className="text-red-700">{error}</span>}
      </div>
    </div>
  );
}

export function ShopClockForm({ shopId, initial, latitude, longitude, myIp }: { shopId: string; initial: ShopClockSettings; latitude: number | null; longitude: number | null; myIp: string | null }) {
  const { pending, error, run } = useAction();
  const [methods, setMethods] = useState(initial.methods);
  const [radius, setRadius] = useState(String(initial.radiusM));
  const [networks, setNetworks] = useState(initial.networks.join("\n"));
  const [photo, setPhoto] = useState(initial.photo);
  const [grace, setGrace] = useState(initial.graceMinutes === null ? "" : String(initial.graceMinutes));
  const [lat, setLat] = useState(latitude === null ? "" : String(latitude));
  const [lng, setLng] = useState(longitude === null ? "" : String(longitude));
  const [blockOnBreak, setBlockOnBreak] = useState(initial.blockOnBreak);
  const [hold, setHold] = useState(String(initial.breakHoldMinutes));
  const [blockAfterClockOut, setBlockAfterClockOut] = useState(initial.blockAfterClockOut);
  const [notInBlock, setNotInBlock] = useState(initial.notInBlock);
  const [openEarly, setOpenEarly] = useState(initial.openEarly);
  const [lateAlert, setLateAlert] = useState(initial.lateAlertMinutes === null ? "" : String(initial.lateAlertMinutes));
  const [ok, setOk] = useState(false);
  const toggle = (m: ClockMethod) => {
    setOk(false);
    setMethods(methods.includes(m) ? methods.filter((x) => x !== m) : [...methods, m]);
  };
  return (
    <form
      className="space-y-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () =>
            saveShopClockAction({
              shopId,
              settings: {
                methods,
                radiusM: num(radius),
                networks: networks.split(/[\s,]+/).filter(Boolean),
                photo,
                graceMinutes: grace.trim() === "" ? null : num(grace),
                blockOnBreak,
                breakHoldMinutes: num(hold),
                blockAfterClockOut,
                notInBlock,
                openEarly,
                lateAlertMinutes: lateAlert.trim() === "" ? null : num(lateAlert),
                nfcTagVersion: initial.nfcTagVersion,
              },
              latitude: lat.trim() === "" ? null : num(lat),
              longitude: lng.trim() === "" ? null : num(lng),
            }),
          () => setOk(true),
        );
      }}
    >
      <div className="text-sm">
        <div className="mb-1 text-xs text-zinc-500">Phone punches must come (any one of):</div>
        <div className="flex flex-wrap gap-4">
          {CLOCK_METHODS.map((m) => (
            <label key={m} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(m)} />
              {METHOD_TEXT[m]}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {methods.length ? `Checked: ${methods.map((m) => METHOD_LABEL[m]).join(", ")}.` : "None checked: punches are accepted from anywhere, and where they came from is still recorded."} The front-desk clock always needs a registered device
          and each person&apos;s PIN. No fingerprint, face or other biometric clock-in is offered.
        </p>
      </div>
      {methods.includes("nfc") && <NfcTag shopId={shopId} />}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Shop latitude">
          <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="41.5868" inputMode="decimal" />
        </Field>
        <Field label="Shop longitude">
          <Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-93.6250" inputMode="decimal" />
        </Field>
        <Field label="Geofence radius (m)">
          <Input type="number" min={25} max={5000} value={radius} onChange={(e) => setRadius(e.target.value)} />
        </Field>
        <Field label="Grace minutes" hint="Blank uses the brand setting.">
          <Input type="number" min={0} max={60} value={grace} onChange={(e) => setGrace(e.target.value)} />
        </Field>
      </div>
      <Field label="Shop network addresses" hint={`The shop's public IP or range (like 203.0.113.7 or 203.0.113.0/24), one per line.${myIp ? ` You're on ${myIp} right now; add it if you're at the shop.` : ""}`}>
        <Textarea rows={2} value={networks} onChange={(e) => setNetworks(e.target.value)} className="font-mono text-xs" />
      </Field>
      <Field label="Photo with each punch" hint="Kept for a manager to look at. Nothing is scanned or matched against a face.">
        <Select value={photo} onChange={(e) => setPhoto(e.target.value as ShopClockSettings["photo"])} className="w-48">
          <option value="off">Off</option>
          <option value="optional">Optional</option>
          <option value="required">Required</option>
        </Select>
      </Field>
      <fieldset className="space-y-2 rounded-lg bg-zinc-50 p-3 text-sm ring-1 ring-zinc-200">
        <legend className="px-1 text-xs font-medium text-zinc-600">The clock blocks out the calendar (real block-outs: online booking, who&apos;s off and reports all see them)</legend>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={blockOnBreak} onChange={(e) => setBlockOnBreak(e.target.checked)} /> A break blocks out
          </label>
          <Input type="number" min={5} max={120} value={hold} onChange={(e) => setHold(e.target.value)} className="w-20" aria-label="Minutes a break blocks when no length is picked" />
          <span className="min-w-[16rem] flex-1">min from its start when no length is picked (on past that while it lasts; trimmed when it ends)</span>
        </div>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={blockAfterClockOut} onChange={(e) => setBlockAfterClockOut(e.target.checked)} /> Clocking out before the scheduled end blocks out the rest of that shift (&quot;Clocked out&quot;, trimmed if they clock back in)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={notInBlock} onChange={(e) => setNotInBlock(e.target.checked)} /> Show a soft &quot;Not in yet&quot; block from the scheduled start until a barber clocks in (barbers who use the clock only)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={openEarly} onChange={(e) => setOpenEarly(e.target.checked)} /> Clocking in early opens the time before the scheduled start, for barbers who allow it on their Time clock page
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <span>Tell managers when a barber isn&apos;t clocked in</span>
          <Input type="number" min={0} max={120} value={lateAlert} onChange={(e) => setLateAlert(e.target.value)} className="w-20" aria-label="Minutes before the first appointment" />
          <span>min before their first appointment (blank: off)</span>
        </div>
        <p className="text-xs text-zinc-500">
          Clients booked inside a clock block are flagged on Today and the calendar, and managers are emailed once per client, with the call-in flow to move or rebook them. Managers can change or remove a clock block on the
          calendar; every change is in the audit log.
        </p>
      </fieldset>
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={pending}>
          Save
        </Button>
        <Saved ok={ok} error={error} />
      </div>
    </form>
  );
}

export function RevokeDevice({ id }: { id: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Stop using this device as a time clock?") && run(() => revokeDeviceAction(id))}>
        Revoke
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </span>
  );
}

/** A one-time QR code (and code to type) that pairs the shop's tablet as its front-desk clock, so no shop login is signed in on it. */
export function PairDevice({ shops }: { shops: { id: string; name: string }[] }) {
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [label, setLabel] = useState("Front desk");
  const [pairing, setPairing] = useState<{ code: string; url: string; svg: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const start = async () => {
    setPending(true);
    setError(null);
    const r = await startPairingAction({ shopId, label });
    setPending(false);
    if (r.ok) setPairing(r.data);
    else setError(r.error);
  };
  if (pairing)
    return (
      <div className="space-y-3 p-4" data-testid="clock-pairing">
        <p className="text-sm">
          On the tablet, scan this code with the camera, or open <span className="font-mono">/clock/pair</span> and type <span className="font-mono text-base font-semibold tracking-wider">{pairing.code}</span>. It works once, until{" "}
          {new Date(pairing.expiresAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" })}.
        </p>
        <div className="h-48 w-48" dangerouslySetInnerHTML={{ __html: pairing.svg }} />
        <Button size="sm" variant="secondary" onClick={() => setPairing(null)}>
          Done
        </Button>
      </div>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        start();
      }}
    >
      {shops.length > 1 && (
        <Select value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop" className="w-48">
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} aria-label="Device name" className="w-48" />
      <Button size="sm" disabled={pending || !shopId || !label.trim()}>
        Pair a clock
      </Button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </form>
  );
}
