"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { MyBadges } from "@/components/my-badges";
import { AddChildInline, FamilyParty, PartyMember, partySummary } from "@/components/family-party";
import { Slot, SlotPicker } from "@/components/slot-picker";
import { Button, Field, Input, cx } from "@/components/ui";
import { ApiError, api, dollars, fmtDay, fmtTime, getTokens, setTokens } from "@/lib/api-client";
import { togglePartyMember } from "@/domain/family";
import { EMAIL_CONSENT_TEXT, SMS_CONSENT_TEXT, consentFields, initialBookingForm } from "@/domain/booking-consent";
import type { BookingCouponView } from "@/server/coupons";
import { checkCouponAction, finishDraftAction, holdCouponAction, saveDraftAction } from "./actions";
import { VerifyPhone, type SignedIn } from "./verify-phone";

interface Service {
  id: string;
  slug: string;
  name: string;
  kind: "service" | "addon";
  category: string;
  priceCents: number;
  durationMin: number;
}
interface Barber {
  id: string;
  slug: string;
  displayName: string;
  color: string;
}
interface ShopInfo {
  slug: string;
  name: string;
  address: string;
  city: string;
  state: string;
  phone: string | null;
  barberCount: number;
  bookingEnabled: boolean;
  cancelCutoffMinutes: number;
  closedNote?: string | null;
  accentColor?: string | null;
  logoUrl?: string | null;
}

type Step = "service" | "barber" | "time" | "details";
type Kid = { id: string; firstName: string; age: number | null; preferredStaffId: string | null };

export function BookingWizard({ shop }: { shop: ShopInfo }) {
  const router = useRouter();
  const params = useSearchParams();
  const [catalog, setCatalog] = useState<{ services: Service[]; addons: Service[] } | null>(null);
  const [barbers, setBarbers] = useState<Barber[] | null>(null);
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [barber, setBarber] = useState<string>(params.get("barber") ?? "any");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [step, setStep] = useState<Step>("service");
  const [form, setForm] = useState(initialBookingForm);
  const [signedIn, setSignedIn] = useState<{ id: string; firstName: string } | null>(null);
  const [kids, setKids] = useState<Kid[]>([]);
  const [maxChildren, setMaxChildren] = useState(0);
  /** Booking without confirming the phone: just for themselves, and nothing about the account shows. */
  const [guest, setGuest] = useState(false);
  const [firstWho, setFirstWho] = useState<string | null>(null);
  const [party, setParty] = useState<PartyMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(crypto.randomUUID());
  const draft = useRef(crypto.randomUUID());
  const [couponText, setCouponText] = useState(params.get("coupon") ?? "");
  const [coupon, setCoupon] = useState<BookingCouponView | null>(null);
  const [couponMsg, setCouponMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);

  async function applyCoupon(code: string, list = catalog) {
    if (!code.trim()) return;
    setCouponBusy(true);
    setCouponMsg(null);
    const r = await checkCouponAction(shop.slug, code);
    setCouponBusy(false);
    if (!r.ok) return setCouponMsg({ ok: false, text: r.error });
    setCoupon(r.data);
    setCouponText(r.data.code);
    const addon = r.data.freeAddonId ? list?.addons.find((a) => a.id === r.data.freeAddonId) : null;
    if (addon) {
      setAddonIds((ids) => (ids.includes(addon.id) ? ids : [...ids, addon.id]));
      if (slot) {
        setSlot(null);
        setStep("time");
      }
      setCouponMsg({ ok: true, text: `${addon.name} added to your booking, free.` });
    }
  }

  function saveDraft(over: { startsAt?: string | null } = {}) {
    if (!serviceId) return;
    saveDraftAction(
      { token: draft.current, shopSlug: shop.slug, serviceId, barberSlug: barber, startsAt: over.startsAt !== undefined ? over.startsAt : (slot?.startsAt ?? null), phone: form.phone || null, email: form.email || null },
      getTokens()?.accessToken ?? null,
    ).catch(() => {});
  }

  useEffect(() => {
    Promise.all([api<{ services: Service[]; addons: Service[] }>(`/shops/${shop.slug}/services`), api<{ barbers: Barber[] }>(`/shops/${shop.slug}/barbers`)])
      .then(([c, b]) => {
        setCatalog(c);
        setBarbers(b.barbers);
        const pre = params.get("service");
        const s = pre ? c.services.find((x) => x.slug === pre || x.id === pre) : null;
        const preBarber = b.barbers.find((x) => x.slug === params.get("barber"));
        const start = params.get("start");
        const at = start ? new Date(start) : null;
        if (s) {
          setServiceId(s.id);
          setStep(params.get("barber") ? "time" : "barber");
          if (preBarber && at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now()) {
            setSlot({ startsAt: at.toISOString(), endsAt: new Date(at.getTime() + s.durationMin * 60_000).toISOString(), barberIds: [preBarber.id] });
            setStep("details");
          }
        }
        if (params.get("barber") && !preBarber) setBarber("any");
        if (params.get("coupon")) applyCoupon(params.get("coupon")!, c);
      })
      .catch((e) => setError(e.message));
    if (getTokens()) loadAccount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop.slug]);

  async function loadAccount() {
    const [me, family] = await Promise.all([
      api<{ id: string; firstName: string }>("/me").catch(() => null),
      api<{ settings: { maxChildren: number }; children: Kid[] }>("/account/family", { base: "/api" }).catch(() => null),
    ]);
    if (!me) return;
    setSignedIn(me);
    setFirstWho(me.id);
    setParty([]);
    setKids(family?.children ?? []);
    setMaxChildren(family?.settings.maxChildren ?? 0);
  }

  async function verified(t: SignedIn) {
    setTokens(t);
    if (t.isNew) {
      const email = form.email.trim();
      await api("/me", { method: "PATCH", body: JSON.stringify({ ...(email ? { email } : {}), ...consentFields(form) }) }).catch(() => {});
    }
    await loadAccount();
  }

  async function notMe() {
    const t = getTokens();
    if (t) await api("/auth/logout", { method: "POST", auth: false, body: JSON.stringify({ refreshToken: t.refreshToken }) }).catch(() => {});
    setTokens(null);
    setSignedIn(null);
    setKids([]);
    setFirstWho(null);
    setParty([]);
    setForm(initialBookingForm());
  }

  async function addChild(input: { firstName: string; age: number | null }) {
    try {
      const kid = await api<Kid>("/account/family/children", { base: "/api", method: "POST", body: JSON.stringify(input) });
      setKids((k) => [...k, kid]);
      if (signedIn && service) setParty(togglePartyMember({ firstWho: firstWho ?? signedIn.id, party }, kid.id, { serviceId: service.id, staffId: kid.preferredStaffId }).party);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  // Keep the URL shareable. Only slugs go in the URL — never names.
  useEffect(() => {
    const svc = catalog?.services.find((s) => s.id === serviceId);
    const q = new URLSearchParams();
    if (svc) q.set("service", svc.slug);
    if (barber !== "any") q.set("barber", barber);
    if (coupon) q.set("coupon", coupon.code);
    const next = `/book/${shop.slug}${q.size ? `?${q}` : ""}`;
    window.history.replaceState(null, "", next);
  }, [serviceId, barber, catalog, shop.slug, coupon]);

  useEffect(() => {
    saveDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, barber, slot?.startsAt]);

  const service = catalog?.services.find((s) => s.id === serviceId) ?? null;
  const addons = useMemo(() => (catalog?.addons ?? []).filter((a) => addonIds.includes(a.id)), [catalog, addonIds]);
  const total = (service?.priceCents ?? 0) + addons.reduce((a, x) => a + x.priceCents, 0);
  const minutes = (service?.durationMin ?? 0) + addons.reduce((a, x) => a + x.durationMin, 0);
  const barberObj = barbers?.find((b) => b.slug === barber);
  const assigned = slot && barber === "any" && slot.barberIds.length === 1 ? barbers?.find((b) => b.id === slot.barberIds[0]) : null;

  const grouped = useMemo(() => {
    const g = new Map<string, Service[]>();
    for (const s of catalog?.services ?? []) g.set(s.category, [...(g.get(s.category) ?? []), s]);
    return [...g.entries()];
  }, [catalog]);

  async function bookFamily() {
    if (!service || !slot || !firstWho) return;
    const r = await api<{ appointments: { code: string }[] }>("/account/family/bookings", {
      base: "/api",
      method: "POST",
      body: JSON.stringify({
        shopId: shop.slug,
        people: [
          { customerId: firstWho, serviceId: service.id, addonIds, staffId: barberObj?.id ?? null, startsAt: slot.startsAt },
          ...party.map((m) => ({ customerId: m.customerId, serviceId: m.serviceId, staffId: m.staffId, timing: m.timing })),
        ],
      }),
    });
    const code = r.appointments[0].code;
    if (coupon) await holdCouponAction(code, coupon.code);
    await finishDraftAction(draft.current, code);
    router.push(`/a/${code}?new=1${r.appointments.length > 1 ? `&family=${r.appointments.length}` : ""}`);
  }

  async function book() {
    if (!service || !slot) return;
    setBusy(true);
    setError(null);
    if (signedIn && (party.length || (firstWho && firstWho !== signedIn.id))) {
      try {
        await bookFamily();
      } catch (e) {
        const err = e as ApiError;
        setError(err.message);
        if (err.code === "slot_unavailable") {
          setSlot(null);
          setStep("time");
        }
        setBusy(false);
      }
      return;
    }
    try {
      const r = await api<{ appointment: { code: string } }>("/appointments", {
        method: "POST",
        headers: { "Idempotency-Key": idem.current },
        body: JSON.stringify({
          shopId: shop.slug,
          serviceId: service.id,
          addonIds,
          barberId: barber === "any" ? null : barber,
          startsAt: slot.startsAt,
          customer: signedIn ? undefined : { firstName: form.firstName, lastName: form.lastName || null, phone: form.phone, email: form.email || null, ...consentFields(form) },
        }),
      });
      if (coupon) await holdCouponAction(r.appointment.code, coupon.code);
      await finishDraftAction(draft.current, r.appointment.code);
      router.push(`/a/${r.appointment.code}?new=1`);
    } catch (e) {
      const err = e as ApiError;
      setError(err.message);
      if (err.code === "slot_unavailable") {
        setSlot(null);
        setStep("time");
        idem.current = crypto.randomUUID();
      }
      setBusy(false);
    }
  }

  if (shop.closedNote) return <Closed shop={shop} msg={shop.closedNote} />;
  if (!shop.bookingEnabled) return <Closed shop={shop} msg="Online booking is paused for this shop. Please call us." />;
  if (shop.barberCount === 0) return <Closed shop={shop} msg="This shop is opening soon — no barbers are taking bookings yet." />;

  const canDetails = signedIn || (guest && form.firstName.trim() && form.phone.replace(/\D/g, "").length >= 10);

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <div className="flex items-center gap-3 border-l-4 pl-3" style={{ borderColor: shop.accentColor ?? "transparent" }}>
          {shop.logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shop.logoUrl} alt="" className="h-12 w-12 rounded-lg object-cover" />
          )}
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Book at {shop.name}</h1>
            <p className="text-sm text-zinc-500">
              {shop.address}, {shop.city}, {shop.state}
            </p>
          </div>
        </div>
        {signedIn && <MyBadges compact />}

        <Section n={1} title="Service" done={!!service && step !== "service"} summary={service ? `${service.name}${addons.length ? ` + ${addons.map((a) => a.name).join(", ")}` : ""}` : undefined} onEdit={() => setStep("service")}>
          {!catalog && <div className="h-40 animate-pulse rounded-lg bg-zinc-100" />}
          {grouped.map(([cat, list]) => (
            <div key={cat} className="mb-4">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">{cat}</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {list.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setServiceId(s.id);
                      setSlot(null);
                    }}
                    className={cx("flex items-center justify-between rounded-lg px-3 py-2.5 text-left ring-1 transition", s.id === serviceId ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-zinc-200 hover:ring-zinc-400")}
                  >
                    <span>
                      <span className="block text-sm font-medium">{s.name}</span>
                      <span className="text-xs text-zinc-500">{s.durationMin} min</span>
                    </span>
                    <span className="tabular text-sm font-semibold">{dollars(s.priceCents)}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          {service && (catalog?.addons.length ?? 0) > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Add-ons (optional)</div>
              <div className="flex flex-wrap gap-1.5">
                {catalog!.addons.map((a) => {
                  const on = addonIds.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setAddonIds(on ? addonIds.filter((x) => x !== a.id) : [...addonIds, a.id]);
                        setSlot(null);
                      }}
                      className={cx("rounded-full px-3 py-1.5 text-sm ring-1 transition", on ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:ring-zinc-500")}
                    >
                      {on ? "✓ " : "+ "}
                      {a.name} · {dollars(a.priceCents)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {service && (
            <Button size="lg" className="w-full sm:w-auto" onClick={() => setStep("barber")}>
              Continue
            </Button>
          )}
        </Section>

        <Section n={2} title="Barber" active={step === "barber"} done={!!service && (step === "time" || step === "details")} summary={barber === "any" ? "Any barber" : barberObj?.displayName} onEdit={() => service && setStep("barber")} locked={!service}>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            <BarberTile
              selected={barber === "any"}
              onClick={() => {
                setBarber("any");
                setSlot(null);
                setStep("time");
              }}
              name="Any barber"
              hint="Most openings"
              color="#111318"
            />
            {barbers?.map((b) => (
              <BarberTile
                key={b.id}
                selected={barber === b.slug}
                onClick={() => {
                  setBarber(b.slug);
                  setSlot(null);
                  setStep("time");
                }}
                name={b.displayName}
                color={b.color}
              />
            ))}
          </div>
        </Section>

        <Section n={3} title="Time" active={step === "time"} done={!!slot && step === "details"} summary={slot ? `${fmtDay(slot.startsAt)} · ${fmtTime(slot.startsAt)}` : undefined} onEdit={() => service && setStep("time")} locked={!service || step === "service" || step === "barber"}>
          {service && (
            <SlotPicker
              shop={shop.slug}
              serviceId={service.id}
              addonIds={addonIds}
              barber={barber}
              selected={slot?.startsAt ?? null}
              onPick={(s) => {
                setSlot(s);
                setStep("details");
              }}
            />
          )}
        </Section>

        <Section n={4} title="Your details" active={step === "details"} locked={step !== "details"}>
          {signedIn ? (
            <>
              <p className="mb-3 text-sm text-zinc-600">
                Booking as {signedIn.firstName}.{" "}
                <button type="button" className="underline" onClick={notMe}>
                  Not you?
                </button>
              </p>
              {kids.length > 0 || maxChildren > 0 ? (
                <FamilyParty
                  me={signedIn}
                  kids={kids}
                  services={catalog?.services ?? []}
                  barbers={barbers ?? []}
                  firstServiceId={service?.id ?? null}
                  firstWho={firstWho ?? signedIn.id}
                  onFirstWho={setFirstWho}
                  party={party}
                  onParty={setParty}
                >
                  {kids.length < maxChildren && <AddChildInline onAdd={addChild} />}
                </FamilyParty>
              ) : null}
            </>
          ) : !guest ? (
            <VerifyPhone form={form} setForm={setForm} onSignedIn={verified} onSkip={() => setGuest(true)} />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <p className="text-sm text-zinc-600 sm:col-span-2">
                Booking just for you.{" "}
                <button type="button" className="underline" onClick={() => setGuest(false)}>
                  Confirm your number by text
                </button>{" "}
                to book for your kids too.
              </p>
              <Field label="First name">
                <Input autoComplete="given-name" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </Field>
              <Field label="Last name (optional)" hint="Kept private — never shown to others.">
                <Input autoComplete="family-name" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </Field>
              <Field label="Mobile phone">
                <Input type="tel" inputMode="tel" autoComplete="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} onBlur={() => saveDraft()} placeholder="(319) 555-0123" />
              </Field>
              <Field label="Email (optional)">
                <Input type="email" autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} onBlur={() => saveDraft()} />
              </Field>
              <label className="flex items-start gap-2 text-sm text-zinc-600 sm:col-span-2">
                <input type="checkbox" className="mt-1" checked={form.smsOptIn} onChange={(e) => setForm({ ...form, smsOptIn: e.target.checked })} />
                <span>{SMS_CONSENT_TEXT}</span>
              </label>
              {form.email.trim() && (
                <label className="flex items-center gap-2 text-sm text-zinc-600 sm:col-span-2">
                  <input type="checkbox" checked={form.emailOptIn} onChange={(e) => setForm({ ...form, emailOptIn: e.target.checked })} />
                  {EMAIL_CONSENT_TEXT}
                </label>
              )}
            </div>
          )}
          {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {(signedIn || guest) && (
            <Button size="lg" className="mt-4 w-full sm:w-auto" disabled={!canDetails || busy || !slot} onClick={book}>
              {busy ? "Booking…" : `Book ${slot ? fmtTime(slot.startsAt) : ""}`}
            </Button>
          )}
          <p className="mt-2 text-xs text-zinc-500">No payment needed. Free cancellation up to {shop.cancelCutoffMinutes} minutes before.</p>
        </Section>
      </div>

      <aside className="lg:sticky lg:top-20 lg:self-start">
        <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
          <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Summary</div>
          <div className="mt-2 space-y-1 text-sm">
            <Row k="Shop" v={shop.name} />
            <Row k="Service" v={service?.name ?? "—"} />
            {addons.map((a) => (
              <Row key={a.id} k="Add-on" v={a.name} />
            ))}
            <Row k="Barber" v={barber === "any" ? (assigned ? `Any (${assigned.displayName})` : "Any barber") : (barberObj?.displayName ?? "—")} />
            <Row k="When" v={slot ? `${fmtDay(slot.startsAt)}, ${fmtTime(slot.startsAt)}` : "—"} />
            <Row k="Length" v={minutes ? `${minutes} min` : "—"} />
            {signedIn && (kids.length > 0 || party.length > 0) && <Row k="For" v={partySummary(signedIn, kids, firstWho ?? signedIn.id, party)} />}
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3">
            <span className="text-sm text-zinc-500">Est. price</span>
            <span className="tabular text-lg font-semibold">{dollars(total)}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-400">Tax and tip at checkout. Pay at the shop.</p>
          <div className="mt-3 border-t border-zinc-100 pt-3" data-testid="booking-coupon">
            {coupon ? (
              <div className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-emerald-700">
                    {coupon.code}: {coupon.summary}
                  </span>
                  <button
                    type="button"
                    className="text-xs text-zinc-500 underline"
                    onClick={() => {
                      setCoupon(null);
                      setCouponMsg(null);
                    }}
                  >
                    Remove
                  </button>
                </div>
                {coupon.note && <p className="mt-1 text-xs text-zinc-500">{coupon.note}</p>}
              </div>
            ) : (
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  applyCoupon(couponText);
                }}
              >
                <Input className="w-full uppercase" placeholder="Coupon code" aria-label="Coupon code" value={couponText} onChange={(e) => setCouponText(e.target.value.toUpperCase())} />
                <Button type="submit" variant="secondary" disabled={couponBusy || !couponText.trim()}>
                  Apply
                </Button>
              </form>
            )}
            {couponMsg && <p className={cx("mt-1 text-xs", couponMsg.ok ? "text-emerald-700" : "text-red-700")}>{couponMsg.text}</p>}
          </div>
        </div>
      </aside>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{k}</span>
      <span className="text-right font-medium text-zinc-800">{v}</span>
    </div>
  );
}

function Section({
  n,
  title,
  children,
  active,
  done,
  summary,
  onEdit,
  locked,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  active?: boolean;
  done?: boolean;
  summary?: string;
  onEdit?: () => void;
  locked?: boolean;
}) {
  const open = n === 1 ? !done : active;
  return (
    <section className={cx("rounded-xl bg-white ring-1 ring-zinc-200", locked && !done && "opacity-60")}>
      <div className="flex items-center gap-3 px-4 py-3">
        <span className={cx("grid h-6 w-6 place-items-center rounded-full text-xs font-bold", done ? "bg-emerald-600 text-white" : "bg-zinc-900 text-white")}>{done ? "✓" : n}</span>
        <h2 className="flex-1 font-semibold">{title}</h2>
        {done && summary && (
          <button type="button" onClick={onEdit} className="max-w-[60%] truncate text-right text-sm text-zinc-600 hover:text-zinc-900">
            {summary} <span className="text-brand-600">Change</span>
          </button>
        )}
      </div>
      {open && !locked && <div className="border-t border-zinc-100 px-4 py-4">{children}</div>}
    </section>
  );
}

function BarberTile({ name, hint, color, selected, onClick }: { name: string; hint?: string; color: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={cx("flex items-center gap-3 rounded-lg px-3 py-3 text-left ring-1 transition", selected ? "bg-brand-50 ring-2 ring-brand-600" : "bg-white ring-zinc-200 hover:ring-zinc-400")}>
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-bold text-white" style={{ background: color }}>
        {name === "Any barber" ? "★" : name[0]}
      </span>
      <span>
        <span className="block text-sm font-medium">{name}</span>
        {hint && <span className="text-xs text-zinc-500">{hint}</span>}
      </span>
    </button>
  );
}

function Closed({ shop, msg }: { shop: ShopInfo; msg: string }) {
  return (
    <div className="mx-auto max-w-lg rounded-xl bg-white p-6 text-center ring-1 ring-zinc-200">
      <h1 className="text-xl font-bold">Ray&apos;z {shop.name}</h1>
      <p className="mt-2 text-zinc-600">{msg}</p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium text-brand-600">
        ← Choose another shop
      </Link>
    </div>
  );
}
