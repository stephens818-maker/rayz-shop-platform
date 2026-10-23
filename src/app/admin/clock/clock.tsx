"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, CardHeader, Input, Notice, Select, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { FLAG_LABEL, PUNCH_LABEL, type PunchFlag, type PunchType } from "@/domain/time-clock";
import { kioskPunchAction, kioskStatusAction, punchAction, registerDeviceAction, setOpensEarlyAction, setPinAction } from "./actions";

type Gps = { lat: number; lng: number; accuracyM: number | null };
type Done = { kind: "done"; type: PunchType; at: Date | string; shop: string; flags: PunchFlag[]; notes: string[] };

const time = (d: Date | string) => new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/Chicago" });

const BUTTON_TONE: Record<PunchType, "primary" | "secondary" | "danger" | "dark"> = { in: "primary", break_start: "secondary", break_end: "primary", out: "dark" };

function location(): Promise<Gps | null> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Number.isFinite(p.coords.accuracy) ? Math.round(p.coords.accuracy) : null }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  });
}

/** A small JPEG (about 480 px wide) from the camera, so a punch photo stays a few dozen KB. */
async function shrink(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 480 / Math.max(img.width, img.height));
    const c = document.createElement("canvas");
    c.width = Math.round(img.width * scale);
    c.height = Math.round(img.height * scale);
    c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.7);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function PhotoInput({ mode, value, onChange }: { mode: "off" | "optional" | "required"; value: string | null; onChange: (v: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  if (mode === "off") return null;
  return (
    <div className="flex items-center gap-3 text-sm">
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="user"
        className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          onChange(f ? await shrink(f) : null);
        }}
      />
      {value ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={value} alt="Your punch photo" className="h-14 w-14 rounded-md object-cover" />
      ) : null}
      <Button type="button" variant="secondary" size="sm" onClick={() => ref.current?.click()}>
        {value ? "Retake photo" : mode === "required" ? "Take photo (required)" : "Add a photo (optional)"}
      </Button>
      {value && (
        <button type="button" className="text-xs text-zinc-500 underline" onClick={() => onChange(null)}>
          Remove
        </button>
      )}
    </div>
  );
}

function Result({ r }: { r: Done }) {
  return (
    <Notice tone={r.flags.length ? "amber" : "green"}>
      <strong>
        {PUNCH_LABEL[r.type]} at {time(r.at)}
      </strong>{" "}
      at {r.shop}.{r.flags.length ? ` Flagged: ${r.flags.map((f) => FLAG_LABEL[f]).join(", ")}.` : ""}
      {r.notes.map((n) => (
        <span key={n} className="block">
          {n}
        </span>
      ))}
    </Notice>
  );
}

export interface ClockShop {
  id: string;
  name: string;
  gps: boolean;
  photo: "off" | "optional" | "required";
  rule: string;
}

/** The phone clock: pick the shop you're working at, then clock in, take a break, clock out. */
export function ClockPanel({ shops, state, shiftShopId, since, breakSince, next, defaultShopId }: {
  shops: ClockShop[];
  state: "off" | "working" | "on_break";
  shiftShopId: string | null;
  since: string | null;
  breakSince: string | null;
  next: PunchType[];
  defaultShopId: string | null;
}) {
  const router = useRouter();
  const [shopId, setShopId] = useState(shiftShopId ?? defaultShopId ?? shops[0]?.id ?? "");
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const shop = shops.find((s) => s.id === shopId);

  const go = (type: PunchType, confirmTimeOff = false) =>
    start(async () => {
      setError(null);
      setDone(null);
      let gps: Gps | null = null;
      if (shop?.gps) {
        setStep("Getting your location…");
        gps = await location();
      }
      setStep(null);
      const r = await punchAction({ shopId, type, gps, photo, confirmTimeOff });
      if (!r.ok) return setError(r.error);
      if (r.data.kind === "confirm") {
        if (window.confirm(r.data.message)) go(type, true);
        return;
      }
      setDone(r.data);
      setPhoto(null);
      router.refresh();
    });

  return (
    <Card className="space-y-4 p-5">
      <div>
        <div className="text-xs uppercase tracking-wide text-zinc-500">Right now</div>
        <div className="text-2xl font-semibold">
          {state === "off" ? "Clocked out" : state === "working" ? "Working" : "On a break"}
          {since && state !== "off" ? <span className="ml-2 text-base font-normal text-zinc-500">since {time(breakSince ?? since)}</span> : null}
        </div>
      </div>
      {shops.length > 1 && (
        <label className="block text-sm">
          <span className="mb-1 block text-xs text-zinc-500">Shop you&apos;re working at</span>
          <Select value={shopId} onChange={(e) => setShopId(e.target.value)} disabled={state !== "off"} aria-label="Shop">
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
      )}
      {shop && <p className="text-xs text-zinc-500">{shop.rule}</p>}
      {shop && <PhotoInput mode={shop.photo} value={photo} onChange={setPhoto} />}
      <div className="grid grid-cols-2 gap-3">
        {next.map((t) => (
          <Button key={t} variant={BUTTON_TONE[t]} className={cx("h-14 text-base", next.length === 1 && "col-span-2")} disabled={pending || !shopId} onClick={() => go(t)}>
            {PUNCH_LABEL[t]}
          </Button>
        ))}
      </div>
      {step && <p className="text-sm text-zinc-500">{step}</p>}
      {error && <Notice tone="red">{error}</Notice>}
      {done && <Result r={done} />}
    </Card>
  );
}

export function PinForm({ hasPin }: { hasPin: boolean }) {
  const { pending, error, run } = useAction();
  const [pin, setPin] = useState("");
  const [again, setAgain] = useState("");
  const [saved, setSaved] = useState(false);
  return (
    <Card>
      <CardHeader title="Front-desk PIN" subtitle={hasPin ? "Set. Change it any time." : "Set a 4 to 6 digit PIN to punch on the shop's front-desk clock."} />
      <form
        className="flex flex-wrap items-end gap-3 p-4 pt-0"
        onSubmit={(e) => {
          e.preventDefault();
          setSaved(false);
          if (pin !== again) return;
          run(
            () => setPinAction(pin),
            () => {
              setPin("");
              setAgain("");
              setSaved(true);
            },
          );
        }}
      >
        <Input type="password" inputMode="numeric" autoComplete="new-password" placeholder="New PIN" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))} className="w-32" maxLength={6} aria-label="New PIN" />
        <Input type="password" inputMode="numeric" autoComplete="new-password" placeholder="Again" value={again} onChange={(e) => setAgain(e.target.value.replace(/\D/g, ""))} className="w-32" maxLength={6} aria-label="PIN again" />
        <Button size="sm" disabled={pending || pin.length < 4 || pin !== again}>
          {hasPin ? "Change PIN" : "Set PIN"}
        </Button>
        {pin && again && pin !== again && <span className="text-xs text-red-700">The PINs don&apos;t match.</span>}
        {saved && <span className="text-xs text-emerald-700">Saved.</span>}
        {error && <span className="text-xs text-red-700">{error}</span>}
      </form>
    </Card>
  );
}

/** The barber's own say on whether an early clock-in opens their book early. */
export function OpensEarlyForm({ on, shops }: { on: boolean; shops: string[] }) {
  const { pending, error, run } = useAction();
  const [value, setValue] = useState(on);
  return (
    <Card>
      <CardHeader
        title="Clocking in early"
        subtitle={
          shops.length
            ? `At ${shops.join(" and ")}, clocking in before your scheduled start can open that time for online booking. Only if you say so here.`
            : "None of your shops opens time for an early clock-in right now; this applies if one turns it on."
        }
      />
      <label className="flex items-center gap-2 p-4 pt-0 text-sm">
        <input
          type="checkbox"
          checked={value}
          disabled={pending}
          onChange={(e) => {
            const next = e.target.checked;
            setValue(next);
            run(() => setOpensEarlyAction(next));
          }}
        />
        Open my book from when I clock in, if that&apos;s before my scheduled start
        {error && <span className="text-xs text-red-700">{error}</span>}
      </label>
    </Card>
  );
}

/** Makes this browser a shop's front-desk clock. */
export function RegisterDevice({ shops }: { shops: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [label, setLabel] = useState("Front desk");
  return (
    <Card>
      <CardHeader title="Use this device as a front-desk clock" subtitle="Staff then punch here with their own PIN. Register it once, on the device itself; it stays registered in this browser until revoked in Time clock setup." />
      <form
        className="flex flex-wrap items-end gap-3 p-4 pt-0"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => registerDeviceAction({ shopId, label }));
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
          Register this device
        </Button>
        {error && <span className="text-xs text-red-700">{error}</span>}
      </form>
    </Card>
  );
}

/** The shared front-desk clock: tap your name, type your PIN, punch. It forgets you after each punch. */
export function Kiosk({ shop, people, photo }: { shop: string; people: { id: string; label: string; hasPin: boolean }[]; photo: "off" | "optional" | "required" }) {
  const [who, setWho] = useState<{ id: string; label: string } | null>(null);
  const [pin, setPin] = useState("");
  const [status, setStatus] = useState<{ state: string; next: PunchType[]; shop: string | null; since: string | null } | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [pending, start] = useTransition();

  const reset = () => {
    setWho(null);
    setPin("");
    setStatus(null);
    setShot(null);
  };
  const check = () =>
    start(async () => {
      setError(null);
      const r = await kioskStatusAction({ staffId: who!.id, pin });
      if (!r.ok) {
        setPin("");
        return setError(r.error);
      }
      setStatus(r.data);
    });
  const go = (type: PunchType, confirmTimeOff = false) =>
    start(async () => {
      setError(null);
      const r = await kioskPunchAction({ staffId: who!.id, pin, type, photo: shot, confirmTimeOff });
      if (!r.ok) return setError(r.error);
      if (r.data.kind === "confirm") {
        if (window.confirm(r.data.message)) go(type, true);
        return;
      }
      setDone({ ...r.data, notes: [`${who!.label}`, ...r.data.notes] });
      reset();
    });

  return (
    <div className="space-y-4">
      {done && <Result r={done} />}
      {error && <Notice tone="red">{error}</Notice>}
      {!who ? (
        <Card className="p-4">
          <div className="mb-3 text-sm text-zinc-500">Tap your name at {shop}.</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {people.map((p) => (
              <Button
                key={p.id}
                variant="secondary"
                className="h-14"
                onClick={() => {
                  setDone(null);
                  setError(null);
                  setWho(p);
                }}
                disabled={!p.hasPin}
                title={p.hasPin ? undefined : "No PIN yet: set one on your Time clock page"}
              >
                {p.label}
                {!p.hasPin && <span className="ml-1 text-xs text-zinc-400">(no PIN)</span>}
              </Button>
            ))}
          </div>
        </Card>
      ) : !status ? (
        <Card className="space-y-3 p-4">
          <div className="text-lg font-semibold">{who.label}, type your PIN</div>
          <div className="text-3xl tracking-[0.5em]" aria-label="PIN entered">
            {"•".repeat(pin.length) || "\u00a0"}
          </div>
          <div className="grid max-w-xs grid-cols-3 gap-2">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"].map((k) => (
              <Button
                key={k}
                variant={k === "OK" ? "primary" : "secondary"}
                className="h-14 text-lg"
                disabled={pending || (k === "OK" && pin.length < 4)}
                onClick={() => (k === "⌫" ? setPin(pin.slice(0, -1)) : k === "OK" ? check() : pin.length < 6 && setPin(pin + k))}
              >
                {k}
              </Button>
            ))}
          </div>
          <button type="button" className="text-sm text-zinc-500 underline" onClick={reset}>
            Not you?
          </button>
        </Card>
      ) : (
        <Card className="space-y-3 p-4">
          <div className="text-lg font-semibold">
            {who.label}: {status.state === "off" ? "clocked out" : status.state === "working" ? `working since ${time(status.since!)}` : "on a break"}
          </div>
          <PhotoInput mode={photo} value={shot} onChange={setShot} />
          <div className="grid grid-cols-2 gap-3">
            {status.next.map((t) => (
              <Button key={t} variant={BUTTON_TONE[t]} className="h-16 text-lg" disabled={pending} onClick={() => go(t)}>
                {PUNCH_LABEL[t]}
              </Button>
            ))}
          </div>
          <button type="button" className="text-sm text-zinc-500 underline" onClick={reset}>
            Cancel
          </button>
        </Card>
      )}
    </div>
  );
}
