"use client";

import { useState } from "react";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { METHOD_LABEL, type ClockMethod, type ShopClockSettings } from "@/domain/time-clock";
import { revokeDeviceAction } from "../clock/actions";
import { saveClockRulesAction, saveShopClockAction } from "./actions";

type RulesInput = { unpaidBreakFromMinutes: number; autoMealMinutes: number; autoMealAfterHours: number; forgotOutAfterMinutes: number; maxShiftHours: number; graceMinutes: number; mapping: string };

const num = (s: string) => (s.trim() === "" ? NaN : Number(s));

function Saved({ ok, error }: { ok: boolean; error: string | null }) {
  if (error) return <span className="text-xs text-red-700">{error}</span>;
  return ok ? <span className="text-xs text-emerald-700">Saved.</span> : null;
}

export function RulesForm({ initial, fields }: { initial: RulesInput; fields: { key: string; label: string }[] }) {
  const { pending, error, run } = useAction();
  const [v, setV] = useState(Object.fromEntries(Object.entries(initial).map(([k, x]) => [k, String(x)])) as Record<keyof RulesInput, string>);
  const [ok, setOk] = useState(false);
  const set = (k: keyof RulesInput) => (e: { target: { value: string } }) => {
    setOk(false);
    setV({ ...v, [k]: e.target.value });
  };
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
        run(
          () =>
            saveClockRulesAction({
              unpaidBreakFromMinutes: num(v.unpaidBreakFromMinutes),
              autoMealMinutes: num(v.autoMealMinutes),
              autoMealAfterHours: num(v.autoMealAfterHours),
              forgotOutAfterMinutes: num(v.forgotOutAfterMinutes),
              maxShiftHours: num(v.maxShiftHours),
              graceMinutes: num(v.graceMinutes),
              mapping: v.mapping,
            }),
          () => setOk(true),
        );
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
        <Saved ok={ok} error={error} />
      </div>
    </form>
  );
}

const METHODS: ClockMethod[] = ["device", "gps", "network"];

export function ShopClockForm({ shopId, initial, latitude, longitude, myIp }: { shopId: string; initial: ShopClockSettings; latitude: number | null; longitude: number | null; myIp: string | null }) {
  const { pending, error, run } = useAction();
  const [methods, setMethods] = useState(initial.methods);
  const [radius, setRadius] = useState(String(initial.radiusM));
  const [networks, setNetworks] = useState(initial.networks.join("\n"));
  const [photo, setPhoto] = useState(initial.photo);
  const [grace, setGrace] = useState(initial.graceMinutes === null ? "" : String(initial.graceMinutes));
  const [lat, setLat] = useState(latitude === null ? "" : String(latitude));
  const [lng, setLng] = useState(longitude === null ? "" : String(longitude));
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
              settings: { methods, radiusM: num(radius), networks: networks.split(/[\s,]+/).filter(Boolean), photo, graceMinutes: grace.trim() === "" ? null : num(grace) },
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
          {METHODS.map((m) => (
            <label key={m} className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={methods.includes(m)} onChange={() => toggle(m)} />
              {m === "device" ? "From a registered shop device" : m === "gps" ? "Within the geofence (phone GPS)" : "From the shop's network (Wi-Fi / IP)"}
            </label>
          ))}
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          {methods.length ? `Checked: ${methods.map((m) => METHOD_LABEL[m]).join(", ")}.` : "None checked: punches are accepted from anywhere, and where they came from is still recorded."} The front-desk clock always needs a registered device.
        </p>
      </div>
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
      <Field label="Photo with each punch">
        <Select value={photo} onChange={(e) => setPhoto(e.target.value as ShopClockSettings["photo"])} className="w-48">
          <option value="off">Off</option>
          <option value="optional">Optional</option>
          <option value="required">Required</option>
        </Select>
      </Field>
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
