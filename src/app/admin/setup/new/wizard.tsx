"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Table, Td, Textarea, Th, cx } from "@/components/ui";
import { PAYMENTS_MODES, PAYMENTS_MODE_HINT, PAYMENTS_MODE_LABEL, PAYMENTS_STEP_TITLE, statementDescriptorProblem, type PaymentsMode } from "@/domain/connect";
import { NetworkRuleFields, ruleDraft, ruleFromDraft, type RuleDraft } from "@/components/network-rule-fields";
import { parseProductLines, type LocationDraftInput } from "@/domain/location-draft";
import { DEFAULT_SHOP_HANDOFF, type ShopHandoff, type TipScreen } from "@/domain/handoff";
import { HandoffRuleFields, TipPresetFields, describeTips } from "../../settings/handoff-editors";
import { DEFAULT_NETWORK_RULE, REQUIREMENT_LABEL } from "@/domain/network-access";
import { DEFAULT_HOURS, SUPPORTED_TIMEZONE, US_TIMEZONES } from "@/domain/location-lifecycle";
import { slugify } from "@/lib/ids";
import { WEEKDAYS, hhmmToMinutes, minutesToHHMM, minutesToLabel } from "@/lib/time";
import { checkSlugAction, createLocationAction, startPaymentsOnboardingAction } from "../actions";

type Options = Awaited<ReturnType<typeof import("@/server/location-admin").wizardOptions>>;

const STEPS = [
  { key: "basics", title: "Name and address" },
  { key: "hours", title: "Hours and holidays" },
  { key: "money", title: "Sales tax" },
  { key: "payments", title: PAYMENTS_STEP_TITLE },
  { key: "booking", title: "Online booking" },
  { key: "menu", title: "Services" },
  { key: "retail", title: "Products and par levels" },
  { key: "vendors", title: "Vendors" },
  { key: "team", title: "Team and payroll" },
  { key: "devices", title: "Login, sign-in and phone line" },
  { key: "brand", title: "Branding" },
  { key: "review", title: "Review" },
] as const;
type StepKey = (typeof STEPS)[number]["key"];

type Hours = { weekday: number; open: boolean; openMin: number; closeMin: number };
type MenuRow = { serviceId: string; enabled: boolean; bookableOnline: boolean; priceCents: number | null; durationMin: number | null };
type ProductRow = { productId: string; include: boolean; priceCents: number; parLevel: number | null; lowStockThreshold: number | null };
type TeamRow = { staffId: string; bookable: boolean; access: boolean; primary: boolean; schedule: { weekday: number; startMin: number; endMin: number }[] };

const pct = (n: number) => +(n * 100).toFixed(3);
const cents = (s: string) => (s.trim() === "" ? null : Math.round(Number(s) * 100));
const int = (s: string) => (s.trim() === "" ? null : Math.max(0, Math.round(Number(s))));

export function LocationWizard({
  options,
  brandIntervalMinutes,
  canBank,
  network,
}: {
  options: Options;
  brandIntervalMinutes: number;
  canBank: boolean;
  /** Set when they may limit where staff sign in from. */
  network: { myIp: string | null; exempt: boolean } | null;
}) {
  const [signIn, setSignIn] = useState<RuleDraft>(ruleDraft(DEFAULT_NETWORK_RULE));
  const [step, setStep] = useState<StepKey>("basics");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [slugNote, setSlugNote] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; slug: string; paymentsMode: PaymentsMode; readerProblems: string[]; login: { email: string; password: string } | null } | null>(null);

  const [basics, setBasics] = useState({
    name: "",
    slug: "",
    slugTouched: false,
    address: "",
    city: "",
    state: "",
    zip: "",
    phone: "",
    email: "",
    timezone: SUPPORTED_TIMEZONE as string,
    ownerEntityId: options.owners.find((o) => o.kind === "brand")?.id ?? "",
    groups: [] as string[],
  });
  const [hours, setHours] = useState<Hours[]>(
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => {
      const d = DEFAULT_HOURS.find((h) => h.weekday === weekday);
      return { weekday, open: !!d, openMin: d?.openMin ?? 9 * 60, closeMin: d?.closeMin ?? 17 * 60 };
    }),
  );
  const [holidays, setHolidays] = useState<{ date: string; reason: string }[]>([]);
  const [money, setMoney] = useState({ service: "0", product: "0", verified: false, feeOn: true, fee: "3", feeOnTip: false });
  const [screen, setScreen] = useState<{ own: boolean; tips: TipScreen; rules: Omit<ShopHandoff, "tips"> }>(() => {
    const { tips: _, ...rules } = DEFAULT_SHOP_HANDOFF;
    return { own: false, tips: options.brandTips, rules };
  });
  const [booking, setBooking] = useState({ online: true, interval: "", lead: "15", window: "60", cutoff: "30" });
  const [menuSource, setMenuSource] = useState("brand");
  const [menu, setMenu] = useState<MenuRow[]>(() => menuFrom("brand"));
  const [retailSource, setRetailSource] = useState("none");
  const [retail, setRetail] = useState<ProductRow[]>([]);
  const [bulk, setBulk] = useState("");
  const [bulkNote, setBulkNote] = useState<string | null>(null);
  const [vendorPicks, setVendorPicks] = useState<Record<string, string | null>>({});
  const [team, setTeam] = useState<TeamRow[]>([]);
  const [payFrom, setPayFrom] = useState("");
  const [login, setLogin] = useState({ on: true, label: "", email: "", roleId: options.loginRoles.find((r) => r.key === "front_desk")?.id ?? options.loginRoles[0]?.id ?? "" });
  const [line, setLine] = useState("");
  const [readers, setReaders] = useState<{ label: string; serialNumber: string; registrationCode: string }[]>([]);
  const [pay, setPay] = useState({ mode: "connected" as PaymentsMode, descriptor: "" });
  const [receipt, setReceipt] = useState({ headline: "", footer: "", showLogo: true, showAddress: true, showPhone: true });
  const [brand, setBrand] = useState({ accent: "", logo: "", description: "" });

  function menuFrom(source: string): MenuRow[] {
    return options.services.map((s) => {
      const from = source === "brand" ? null : options.shopServices.find((x) => x.shopId === source && x.serviceId === s.id);
      return {
        serviceId: s.id,
        enabled: source === "brand" ? true : !!from?.enabled,
        bookableOnline: from?.bookableOnline ?? true,
        priceCents: from?.priceCents ?? null,
        durationMin: from?.durationMin ?? null,
      };
    });
  }
  function retailFrom(source: string): ProductRow[] {
    if (source === "none") return [];
    return options.products.map((p) => {
      const from = source === "brand" ? null : options.shopProducts.find((x) => x.shopId === source && x.productId === p.id);
      return {
        productId: p.id,
        include: source === "brand" || !!from,
        priceCents: from?.priceCents ?? p.priceCents,
        parLevel: from?.parLevel ?? null,
        lowStockThreshold: from?.lowStockThreshold ?? null,
      };
    });
  }

  const shopHoursFor = (weekday: number) => hours.find((h) => h.weekday === weekday && h.open);
  const defaultSchedule = () => hours.filter((h) => h.open).map((h) => ({ weekday: h.weekday, startMin: h.openMin, endMin: h.closeMin }));

  const draft = useMemo<LocationDraftInput>(
    () => ({
      name: basics.name,
      slug: basics.slug,
      address: basics.address,
      city: basics.city,
      state: basics.state,
      zip: basics.zip,
      phone: basics.phone.trim() || null,
      email: basics.email.trim() || null,
      timezone: basics.timezone,
      ownerEntityId: basics.ownerEntityId || null,
      description: brand.description.trim() || null,
      hours: hours.filter((h) => h.open).map(({ weekday, openMin, closeMin }) => ({ weekday, openMin, closeMin })),
      holidays: holidays.filter((h) => h.date).map((h) => ({ date: h.date, reason: h.reason.trim() || null })),
      serviceTaxRate: Number(money.service) / 100,
      productTaxRate: Number(money.product) / 100,
      taxRatesVerified: money.verified,
      cardFeeEnabled: money.feeOn,
      cardFeeRate: Number(money.fee) / 100,
      cardFeeAppliesToTip: money.feeOnTip,
      tipPresets: (screen.own ? screen.tips : options.brandTips).type === "percent" ? (screen.own ? screen.tips : options.brandTips).values : [20, 25, 30],
      handoff: { ...screen.rules, tips: screen.own ? screen.tips : null },
      slotIntervalMinutes: booking.interval ? (Number(booking.interval) as 5 | 10 | 15 | 20 | 30) : null,
      minLeadMinutes: Number(booking.lead) || 0,
      bookingWindowDays: Number(booking.window) || 60,
      cancelCutoffMinutes: Number(booking.cutoff) || 0,
      bookingEnabled: booking.online,
      services: menu,
      products: retail.filter((r) => r.include).map(({ include: _, ...r }) => r),
      vendors: Object.entries(vendorPicks).map(([vendorId, accountNumber]) => ({ vendorId, accountNumber: accountNumber?.trim() || null })),
      staff: team,
      payCalendarFromShopId: payFrom || null,
      locationGroupIds: basics.groups,
      login: login.on && login.email.trim() ? { label: login.label.trim() || `${basics.name} desk`.slice(0, 24), email: login.email, roleId: login.roleId } : null,
      twilioNumber: line.trim() || null,
      readers: readers.filter((r) => r.label.trim()).map((r) => ({ label: r.label, serialNumber: r.serialNumber.trim() || null, registrationCode: r.registrationCode.trim() || null })),
      paymentsMode: canBank ? pay.mode : "connected",
      statementDescriptor: canBank ? pay.descriptor.trim().toUpperCase() || null : null,
      receipt: { ...receipt, headline: receipt.headline.trim() || null, footer: receipt.footer.trim() || null },
      accentColor: brand.accent || null,
      logoUrl: brand.logo.trim() || null,
      networkAccess: network ? ruleFromDraft(signIn) : DEFAULT_NETWORK_RULE,
    }),
    [basics, hours, holidays, money, screen, options.brandTips, booking, menu, retail, vendorPicks, team, payFrom, login, line, readers, brand, pay, receipt, canBank, network, signIn],
  );

  const index = STEPS.findIndex((s) => s.key === step);
  const go = (d: number) => setStep(STEPS[Math.min(STEPS.length - 1, Math.max(0, index + d))].key);
  const owner = options.owners.find((o) => o.id === basics.ownerEntityId);
  const descriptorIssue = pay.descriptor.trim() ? statementDescriptorProblem(pay.descriptor.trim().toUpperCase()) : null;
  const sameState = options.shops.filter((s) => basics.state && s.state.toUpperCase() === basics.state.toUpperCase());

  function checkSlug(slug: string) {
    if (!slug) return setSlugNote(null);
    start(async () => {
      const r = await checkSlugAction(slug);
      setSlugNote(r.ok ? r.data : r.error);
    });
  }

  function submit() {
    setError(null);
    start(async () => {
      const r = await createLocationAction(draft);
      if (!r.ok) return setError(r.error);
      setDone(r.data);
    });
  }

  function onboard(id: string) {
    setError(null);
    start(async () => {
      const r = await startPaymentsOnboardingAction(id);
      if (!r.ok) return setError(r.error);
      window.location.href = r.data.url;
    });
  }

  if (done)
    return (
      <Card className="space-y-4 p-6">
        <Notice tone="green">
          {basics.name} is saved and hidden from clients while you finish setting it up. Its booking link will be <code>/book/{done.slug}</code>.
        </Notice>
        {done.login && (
          <Notice tone="blue">
            Front desk login: <strong>{done.login.email}</strong> with password <code className="select-all">{done.login.password}</code>. It&apos;s shown only once, so
            write it down or save it on the shop&apos;s tablet now.
          </Notice>
        )}
        {done.readerProblems.length > 0 && (
          <Notice tone="amber">
            Some card readers weren&apos;t registered: {done.readerProblems.join("; ")}. Register them from Shop settings with the code each reader shows.
          </Notice>
        )}
        {done.paymentsMode === "connected" && (
          <Notice tone="blue">
            Next: Stripe collects {basics.name}&apos;s legal entity, EIN, owner identity and bank account on its own secure pages. Ray&apos;z never sees or stores the bank or
            Social Security numbers. Cards start working once Stripe enables charges.
          </Notice>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {done.paymentsMode === "connected" && canBank && (
            <Button disabled={pending} onClick={() => onboard(done.id)}>
              {pending ? "Opening Stripe…" : "Continue to Stripe onboarding"}
            </Button>
          )}
          <Link
            className={cx(
              "rounded-lg px-4 py-2 text-sm font-medium",
              done.paymentsMode === "connected" && canBank ? "border border-zinc-200 text-zinc-700 hover:bg-zinc-50" : "bg-brand-600 text-white hover:bg-brand-700",
            )}
            href={`/admin/setup?shop=${done.id}`}
          >
            Open the go-live checklist
          </Link>
          <Link className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50" href="/admin/setup">
            All locations
          </Link>
        </div>
      </Card>
    );

  return (
    <div className="grid gap-5 md:grid-cols-[14rem_1fr]">
      <nav aria-label="Wizard steps">
        <ol className="space-y-1 text-sm">
          {STEPS.map((s, i) => (
            <li key={s.key}>
              <button
                type="button"
                onClick={() => setStep(s.key)}
                aria-current={s.key === step ? "step" : undefined}
                className={cx(
                  "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left",
                  s.key === step ? "bg-brand-50 font-semibold text-brand-800" : "text-zinc-600 hover:bg-zinc-50",
                )}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-xs">{i + 1}</span>
                {s.title}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <Card>
        <CardHeader title={STEPS[index].title} subtitle={`Step ${index + 1} of ${STEPS.length}`} />
        <div className="space-y-4 p-4">
          {step === "basics" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Location name" hint="What clients and staff see, e.g. “Ray'z Iowa City”.">
                <Input
                  value={basics.name}
                  onChange={(e) => setBasics({ ...basics, name: e.target.value, slug: basics.slugTouched ? basics.slug : slugify(e.target.value).slice(0, 40) })}
                  onBlur={() => !basics.slugTouched && checkSlug(basics.slug)}
                />
              </Field>
              <Field label="Booking link" hint={slugNote ? <span className="text-red-600">{slugNote}</span> : `rayz…/book/${basics.slug || "…"} · never a surname`}>
                <Input value={basics.slug} onChange={(e) => setBasics({ ...basics, slug: e.target.value.toLowerCase(), slugTouched: true })} onBlur={() => checkSlug(basics.slug)} />
              </Field>
              <Field label="Street address" className="sm:col-span-2">
                <Input value={basics.address} onChange={(e) => setBasics({ ...basics, address: e.target.value })} />
              </Field>
              <Field label="City">
                <Input value={basics.city} onChange={(e) => setBasics({ ...basics, city: e.target.value })} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="State">
                  <Input maxLength={2} value={basics.state} onChange={(e) => setBasics({ ...basics, state: e.target.value.toUpperCase() })} />
                </Field>
                <Field label="ZIP">
                  <Input inputMode="numeric" value={basics.zip} onChange={(e) => setBasics({ ...basics, zip: e.target.value })} />
                </Field>
              </div>
              <Field label="Shop phone" hint="Rings when clients call the shop line.">
                <Input type="tel" value={basics.phone} onChange={(e) => setBasics({ ...basics, phone: e.target.value })} />
              </Field>
              <Field label="Shop email" hint="Replies to the shop's emails go here; low-stock alerts too.">
                <Input type="email" value={basics.email} onChange={(e) => setBasics({ ...basics, email: e.target.value })} />
              </Field>
              <Field label="Time zone" hint={basics.timezone !== SUPPORTED_TIMEZONE ? <span className="text-amber-700">Every shop runs on Central time today, so this location can&apos;t go live until that changes.</span> : undefined}>
                <Select value={basics.timezone} onChange={(e) => setBasics({ ...basics, timezone: e.target.value })}>
                  {US_TIMEZONES.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label} ({z.id})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Owner" hint="Whose P&L the shop rolls up to.">
                <Select value={basics.ownerEntityId} onChange={(e) => setBasics({ ...basics, ownerEntityId: e.target.value })}>
                  {options.owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                      {o.kind === "franchisee" ? " (franchisee)" : ""}
                    </option>
                  ))}
                </Select>
              </Field>
              {options.groups.length > 0 && (
                <fieldset className="sm:col-span-2">
                  <legend className="mb-1 text-sm font-medium text-zinc-700">Location groups</legend>
                  <div className="flex flex-wrap gap-3">
                    {options.groups.map((g) => (
                      <label key={g.id} className="flex items-center gap-2 text-sm text-zinc-700">
                        <input
                          type="checkbox"
                          checked={basics.groups.includes(g.id)}
                          onChange={(e) => setBasics({ ...basics, groups: e.target.checked ? [...basics.groups, g.id] : basics.groups.filter((x) => x !== g.id) })}
                        />
                        {g.name}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </div>
          )}

          {step === "hours" && (
            <div className="space-y-4">
              <Table>
                <thead>
                  <tr>
                    <Th>Day</Th>
                    <Th>Open</Th>
                    <Th>Opens</Th>
                    <Th>Closes</Th>
                  </tr>
                </thead>
                <tbody>
                  {hours.map((h, i) => (
                    <tr key={h.weekday}>
                      <Td>{WEEKDAYS[h.weekday]}</Td>
                      <Td>
                        <input
                          type="checkbox"
                          aria-label={`Open on ${WEEKDAYS[h.weekday]}`}
                          checked={h.open}
                          onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.checked } : x)))}
                        />
                      </Td>
                      <Td>
                        <Input type="time" disabled={!h.open} value={minutesToHHMM(h.openMin)} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, openMin: hhmmToMinutes(e.target.value) } : x)))} />
                      </Td>
                      <Td>
                        <Input type="time" disabled={!h.open} value={minutesToHHMM(h.closeMin)} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closeMin: hhmmToMinutes(e.target.value) } : x)))} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
              <p className="text-xs text-zinc-500">Sunday is closed unless you open it here.</p>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-zinc-800">Holidays and closed days</h3>
                {holidays.map((h, i) => (
                  <div key={i} className="flex flex-wrap gap-2">
                    <Input type="date" className="w-44" value={h.date} onChange={(e) => setHolidays(holidays.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
                    <Input className="w-60" placeholder="Reason (Thanksgiving)" value={h.reason} onChange={(e) => setHolidays(holidays.map((x, j) => (j === i ? { ...x, reason: e.target.value } : x)))} />
                    <Button variant="ghost" size="sm" onClick={() => setHolidays(holidays.filter((_, j) => j !== i))}>
                      Remove
                    </Button>
                  </div>
                ))}
                <Button variant="secondary" size="sm" onClick={() => setHolidays([...holidays, { date: "", reason: "" }])}>
                  + Add a closed day
                </Button>
              </div>
            </div>
          )}

          {step === "money" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Service tax %" hint="0 where services aren't taxed.">
                <Input inputMode="decimal" value={money.service} onChange={(e) => setMoney({ ...money, service: e.target.value, verified: false })} />
              </Field>
              <Field label="Product tax %">
                <Input inputMode="decimal" value={money.product} onChange={(e) => setMoney({ ...money, product: e.target.value, verified: false })} />
              </Field>
              {sameState.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-600 sm:col-span-2">
                  Start from:
                  {sameState.map((s) => (
                    <Button key={s.id} size="sm" variant="secondary" onClick={() => setMoney({ ...money, service: String(pct(s.serviceTaxRate)), product: String(pct(s.productTaxRate)), verified: false })}>
                      {s.name} ({pct(s.serviceTaxRate)}% / {pct(s.productTaxRate)}%)
                    </Button>
                  ))}
                </div>
              )}
              <label className="flex items-start gap-2 text-sm text-zinc-700 sm:col-span-2">
                <input type="checkbox" className="mt-1" checked={money.verified} onChange={(e) => setMoney({ ...money, verified: e.target.checked })} />
                <span>
                  I&apos;ve confirmed these rates for this address with the state (and city or county, if they add one).
                  {!money.verified && <Badge tone="amber" className="ml-2">Flagged until confirmed</Badge>}
                </span>
              </label>
            </div>
          )}

          {step === "payments" && (
            <div className="space-y-5">
              <fieldset className="space-y-2" disabled={!canBank}>
                <legend className="text-sm font-semibold text-zinc-800">Where card money goes</legend>
                {!canBank && (
                  <Notice tone="amber">
                    Only the Brand Owner, or someone they&apos;ve given the banking permission, can choose this. The shop starts on its own Stripe account; they connect it from
                    the checklist.
                  </Notice>
                )}
                {PAYMENTS_MODES.map((m) => (
                  <label key={m} className="flex items-start gap-2 rounded-lg border border-zinc-200 p-3 text-sm text-zinc-700 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50">
                    <input type="radio" name="payments-mode" className="mt-1" checked={pay.mode === m} onChange={() => setPay({ ...pay, mode: m })} />
                    <span>
                      <span className="font-medium text-zinc-900">{PAYMENTS_MODE_LABEL[m]}</span>
                      <span className="block text-zinc-500">{PAYMENTS_MODE_HINT[m]}</span>
                    </span>
                  </label>
                ))}
                {owner?.kind === "franchisee" && pay.mode === "brand" && (
                  <Notice tone="amber">{owner.name} is a franchisee. Its card money would land in the brand&apos;s bank; a separate business usually takes its own account.</Notice>
                )}
                {pay.mode === "connected" && (
                  <p className="text-sm text-zinc-500">
                    After you create the location, Stripe&apos;s own pages collect the legal entity, EIN, owner identity and bank account. Ray&apos;z stores only the Stripe
                    account ID and what Stripe reports back.
                  </p>
                )}
                {pay.mode !== "cash_only" && (
                  <Field
                    label="Statement descriptor"
                    hint={
                      pay.mode === "brand"
                        ? "What clients see on their card statement, after the brand's prefix. 5 to 22 letters and numbers; blank uses the brand's."
                        : "What clients see on their card statement, e.g. RAYZ CORALVILLE. 5 to 22 letters and numbers; blank lets Stripe use the business name."
                    }
                  >
                    <Input maxLength={22} className="w-64 uppercase" placeholder={`RAYZ ${basics.name.replace(/^ray'?z\s*/i, "").toUpperCase()}`.slice(0, 22)} value={pay.descriptor} onChange={(e) => setPay({ ...pay, descriptor: e.target.value })} />
                    {descriptorIssue && <span className="mt-1 block text-sm text-red-700">{descriptorIssue}</span>}
                  </Field>
                )}
              </fieldset>
              {pay.mode !== "cash_only" && (
                <fieldset className="grid gap-3 sm:grid-cols-2">
                  <legend className="mb-2 text-sm font-semibold text-zinc-800">Card fee</legend>
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input type="checkbox" checked={money.feeOn} onChange={(e) => setMoney({ ...money, feeOn: e.target.checked })} /> Pass the card fee on to clients
                  </label>
                  <Field label="Card fee %">
                    <Input inputMode="decimal" disabled={!money.feeOn} value={money.fee} onChange={(e) => setMoney({ ...money, fee: e.target.value })} />
                  </Field>
                  <label className="flex items-center gap-2 text-sm text-zinc-700">
                    <input type="checkbox" disabled={!money.feeOn} checked={money.feeOnTip} onChange={(e) => setMoney({ ...money, feeOnTip: e.target.checked })} /> Charge the fee on tips too
                  </label>
                </fieldset>
              )}
              {pay.mode !== "cash_only" && (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-semibold text-zinc-800">Stripe Terminal card readers</legend>
                  <p className="text-sm text-zinc-500">
                    Each reader is registered to this shop&apos;s own Terminal location, so its payments land in this shop&apos;s books. Enter the code the reader shows
                    (Settings, then Generate pairing code). Without a code it&apos;s saved as a placeholder to register later.
                  </p>
                  {readers.map((r, i) => (
                    <div key={i} className="flex flex-wrap gap-2">
                      <Input className="w-48" placeholder="Front counter" aria-label="Reader name" value={r.label} onChange={(e) => setReaders(readers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                      <Input className="w-44" placeholder="Serial number" aria-label="Serial number" value={r.serialNumber} onChange={(e) => setReaders(readers.map((x, j) => (j === i ? { ...x, serialNumber: e.target.value } : x)))} />
                      <Input
                        className="w-52"
                        placeholder="Registration code"
                        aria-label="Registration code"
                        value={r.registrationCode}
                        onChange={(e) => setReaders(readers.map((x, j) => (j === i ? { ...x, registrationCode: e.target.value } : x)))}
                      />
                      <Button variant="ghost" size="sm" onClick={() => setReaders(readers.filter((_, j) => j !== i))}>
                        Remove
                      </Button>
                    </div>
                  ))}
                  <Button variant="secondary" size="sm" onClick={() => setReaders([...readers, { label: "", serialNumber: "", registrationCode: "" }])}>
                    + Add a reader
                  </Button>
                </fieldset>
              )}
              <fieldset className="space-y-3">
                <legend className="mb-2 text-sm font-semibold text-zinc-800">Customer screen at checkout</legend>
                <p className="text-sm text-zinc-500">&ldquo;Hand to customer&rdquo; turns the device to the client for the tip, signature, receipt and payment, locked to the ticket until a staff PIN.</p>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="radio" name="wizard-tips" checked={!screen.own} onChange={() => setScreen({ ...screen, own: false })} /> The brand&apos;s tip buttons: {describeTips(options.brandTips)}
                </label>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="radio" name="wizard-tips" checked={screen.own} onChange={() => setScreen({ ...screen, own: true })} /> This location&apos;s own
                </label>
                {screen.own && (
                  <div className="ml-6 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                    <TipPresetFields value={screen.tips} onChange={(tips) => setScreen({ ...screen, tips })} />
                  </div>
                )}
                <HandoffRuleFields value={screen.rules} onChange={(rules) => setScreen({ ...screen, rules })} hasReaders={pay.mode !== "cash_only" && readers.some((r) => r.label.trim())} />
              </fieldset>
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-2 text-sm font-semibold text-zinc-800">Receipts</legend>
                <Field label="Headline" hint={`Blank prints "Ray'z Barber Shop · ${basics.name || "this shop"}".`}>
                  <Input maxLength={60} value={receipt.headline} onChange={(e) => setReceipt({ ...receipt, headline: e.target.value })} />
                </Field>
                <Field label="Footer" hint="Blank prints the brand's thank-you line.">
                  <Input maxLength={200} value={receipt.footer} onChange={(e) => setReceipt({ ...receipt, footer: e.target.value })} />
                </Field>
                <div className="flex flex-wrap gap-4 text-sm text-zinc-700 sm:col-span-2">
                  {(
                    [
                      ["showLogo", "Logo"],
                      ["showAddress", "Address"],
                      ["showPhone", "Phone"],
                    ] as const
                  ).map(([k, label]) => (
                    <label key={k} className="flex items-center gap-2">
                      <input type="checkbox" checked={receipt[k]} onChange={(e) => setReceipt({ ...receipt, [k]: e.target.checked })} /> {label}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          {step === "booking" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-sm text-zinc-700 sm:col-span-2">
                <input type="checkbox" checked={booking.online} onChange={(e) => setBooking({ ...booking, online: e.target.checked })} /> Take online bookings once the location goes live
              </label>
              <Field label="Slot interval" hint={`How far apart start times are. The brand default is ${brandIntervalMinutes} minutes.`}>
                <Select value={booking.interval} onChange={(e) => setBooking({ ...booking, interval: e.target.value })}>
                  <option value="">Brand default ({brandIntervalMinutes} min)</option>
                  {[5, 10, 15, 20, 30].map((n) => (
                    <option key={n} value={n}>
                      {n} minutes
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Earliest booking (minutes from now)">
                <Input inputMode="numeric" value={booking.lead} onChange={(e) => setBooking({ ...booking, lead: e.target.value })} />
              </Field>
              <Field label="How far ahead clients can book (days)">
                <Input inputMode="numeric" value={booking.window} onChange={(e) => setBooking({ ...booking, window: e.target.value })} />
              </Field>
              <Field label="Online cancel cutoff (minutes before)">
                <Input inputMode="numeric" value={booking.cutoff} onChange={(e) => setBooking({ ...booking, cutoff: e.target.value })} />
              </Field>
            </div>
          )}

          {step === "menu" && (
            <div className="space-y-3">
              <Field label="Start from">
                <Select
                  value={menuSource}
                  onChange={(e) => {
                    setMenuSource(e.target.value);
                    setMenu(menuFrom(e.target.value));
                  }}
                >
                  <option value="brand">The brand menu, at brand prices</option>
                  {options.shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      Copy {s.name}&apos;s menu and prices
                    </option>
                  ))}
                </Select>
              </Field>
              <Table>
                <thead>
                  <tr>
                    <Th>Offer</Th>
                    <Th>Service</Th>
                    <Th>Online</Th>
                    <Th>Price</Th>
                    <Th>Minutes</Th>
                  </tr>
                </thead>
                <tbody>
                  {menu.map((m, i) => {
                    const s = options.services.find((x) => x.id === m.serviceId)!;
                    const set = (p: Partial<MenuRow>) => setMenu(menu.map((x, j) => (j === i ? { ...x, ...p } : x)));
                    return (
                      <tr key={m.serviceId} className={cx(!m.enabled && "opacity-50")}>
                        <Td>
                          <input type="checkbox" aria-label={`Offer ${s.name}`} checked={m.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                        </Td>
                        <Td>
                          {s.name}
                          {s.kind === "addon" && <span className="ml-1 text-xs text-zinc-400">add-on</span>}
                        </Td>
                        <Td>
                          <input type="checkbox" aria-label={`${s.name} bookable online`} checked={m.bookableOnline} onChange={(e) => set({ bookableOnline: e.target.checked })} />
                        </Td>
                        <Td>
                          <Input
                            className="w-24"
                            inputMode="decimal"
                            aria-label={`${s.name} price`}
                            placeholder={(s.priceCents / 100).toFixed(2)}
                            value={m.priceCents === null ? "" : (m.priceCents / 100).toFixed(2)}
                            onChange={(e) => set({ priceCents: cents(e.target.value) })}
                          />
                        </Td>
                        <Td>
                          <Input className="w-20" inputMode="numeric" aria-label={`${s.name} minutes`} placeholder={String(s.durationMin)} value={m.durationMin ?? ""} onChange={(e) => set({ durationMin: int(e.target.value) })} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              <p className="text-xs text-zinc-500">Blank price or minutes follow the brand, so brand price changes reach this shop too.</p>
            </div>
          )}

          {step === "retail" && (
            <div className="space-y-3">
              <Field label="Start from">
                <Select
                  value={retailSource}
                  onChange={(e) => {
                    setRetailSource(e.target.value);
                    setRetail(retailFrom(e.target.value));
                  }}
                >
                  <option value="none">No retail yet</option>
                  <option value="brand">Every brand product, at brand prices and par levels</option>
                  {options.shops.map((s) => (
                    <option key={s.id} value={s.id}>
                      Copy {s.name}&apos;s products, prices and par levels
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Or paste a list" hint="One product per line: sku,price,par,reorder. Blank cells keep the brand's. Products must already be in the catalog (Bulk upload adds new ones).">
                <Textarea rows={4} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={"sku,price,par,reorder\nREU-POM-35,24.00,8,3"} />
              </Field>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!bulk.trim()}
                  onClick={() => {
                    const { rows, errors } = parseProductLines(bulk);
                    const base = retail.length ? retail : retailFrom("brand").map((r) => ({ ...r, include: false }));
                    const unknown: string[] = [];
                    const next = [...base];
                    for (const r of rows) {
                      const p = options.products.find((x) => x.sku.toLowerCase() === r.sku.toLowerCase());
                      if (!p) {
                        unknown.push(r.sku);
                        continue;
                      }
                      const i = next.findIndex((x) => x.productId === p.id);
                      next[i] = { ...next[i], include: true, priceCents: r.priceCents ?? next[i].priceCents, parLevel: r.parLevel ?? next[i].parLevel, lowStockThreshold: r.lowStockThreshold ?? next[i].lowStockThreshold };
                    }
                    setRetail(next);
                    setRetailSource("custom");
                    setBulkNote([`${rows.length - unknown.length} products applied.`, ...errors, unknown.length ? `Not in the catalog: ${unknown.join(", ")}` : ""].filter(Boolean).join(" "));
                  }}
                >
                  Apply list
                </Button>
                {bulkNote && <span className="text-sm text-zinc-600">{bulkNote}</span>}
              </div>
              {retail.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <Th>Stock</Th>
                      <Th>Product</Th>
                      <Th>Price</Th>
                      <Th>Par</Th>
                      <Th>Reorder at</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {retail.map((r, i) => {
                      const p = options.products.find((x) => x.id === r.productId)!;
                      const set = (v: Partial<ProductRow>) => setRetail(retail.map((x, j) => (j === i ? { ...x, ...v } : x)));
                      return (
                        <tr key={r.productId} className={cx(!r.include && "opacity-50")}>
                          <Td>
                            <input type="checkbox" aria-label={`Stock ${p.name}`} checked={r.include} onChange={(e) => set({ include: e.target.checked })} />
                          </Td>
                          <Td>
                            {p.brand} {p.name} <span className="text-xs text-zinc-400">{p.sku}</span>
                          </Td>
                          <Td>
                            <Input className="w-24" inputMode="decimal" aria-label={`${p.name} price`} value={(r.priceCents / 100).toFixed(2)} onChange={(e) => set({ priceCents: cents(e.target.value) ?? 0 })} />
                          </Td>
                          <Td>
                            <Input className="w-16" inputMode="numeric" aria-label={`${p.name} par`} placeholder={String(p.parLevel)} value={r.parLevel ?? ""} onChange={(e) => set({ parLevel: int(e.target.value) })} />
                          </Td>
                          <Td>
                            <Input className="w-16" inputMode="numeric" aria-label={`${p.name} reorder point`} placeholder={String(p.lowStockThreshold)} value={r.lowStockThreshold ?? ""} onChange={(e) => set({ lowStockThreshold: int(e.target.value) })} />
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              )}
              <p className="text-xs text-zinc-500">Shelves start empty; receive the opening order or a transfer to stock them.</p>
            </div>
          )}

          {step === "vendors" && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-600">Who this shop orders from, with its own account number there. Leave all unticked to order from any vendor.</p>
              {options.vendors.map((v) => (
                <div key={v.id} className="flex flex-wrap items-center gap-3">
                  <label className="flex w-56 items-center gap-2 text-sm text-zinc-700">
                    <input
                      type="checkbox"
                      checked={v.id in vendorPicks}
                      onChange={(e) => {
                        const next = { ...vendorPicks };
                        if (e.target.checked) next[v.id] = "";
                        else delete next[v.id];
                        setVendorPicks(next);
                      }}
                    />
                    {v.name}
                  </label>
                  {v.id in vendorPicks && (
                    <Input
                      className="w-56"
                      placeholder={v.accountNumber ? `Brand account ${v.accountNumber}` : "Shop's account number"}
                      aria-label={`${v.name} account number`}
                      value={vendorPicks[v.id] ?? ""}
                      onChange={(e) => setVendorPicks({ ...vendorPicks, [v.id]: e.target.value })}
                    />
                  )}
                </div>
              ))}
              {options.vendors.length === 0 && <p className="text-sm text-zinc-500">No vendors yet. Add them under Vendors.</p>}
            </div>
          )}

          {step === "team" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-600">
                Pick who works here. Barbers can work at several shops; their hours here can&apos;t overlap their hours elsewhere. New hires are added under Staff &amp; schedules first.
              </p>
              <ul className="divide-y divide-zinc-100 rounded-lg border border-zinc-200">
                {options.staff.map((p) => {
                  const row = team.find((t) => t.staffId === p.id);
                  const set = (v: Partial<TeamRow>) => setTeam(team.map((t) => (t.staffId === p.id ? { ...t, ...v } : t)));
                  return (
                    <li key={p.id} className="space-y-2 px-3 py-2">
                      <label className="flex flex-wrap items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={!!row}
                          onChange={(e) =>
                            setTeam(
                              e.target.checked
                                ? [...team, { staffId: p.id, bookable: p.isBookable, access: p.scope !== "all", primary: p.shops.length === 0, schedule: p.isBookable ? defaultSchedule() : [] }]
                                : team.filter((t) => t.staffId !== p.id),
                            )
                          }
                        />
                        <span className="font-medium text-zinc-900">{p.label}</span>
                        <span className="text-xs text-zinc-500">{p.shops.length ? `Also at ${p.shops.join(", ")}` : "No shop yet"}</span>
                      </label>
                      {row && (
                        <div className="space-y-2 pl-6">
                          <div className="flex flex-wrap gap-4 text-sm text-zinc-700">
                            <label className="flex items-center gap-1">
                              <input type="checkbox" checked={row.bookable} onChange={(e) => set({ bookable: e.target.checked })} /> Bookable online here
                            </label>
                            {p.scope !== "all" && (
                              <label className="flex items-center gap-1">
                                <input type="checkbox" checked={row.access} onChange={(e) => set({ access: e.target.checked })} /> Can sign in to this shop
                              </label>
                            )}
                            <label className="flex items-center gap-1">
                              <input type="checkbox" checked={row.primary} onChange={(e) => set({ primary: e.target.checked })} /> Home shop
                            </label>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {[0, 1, 2, 3, 4, 5, 6].map((wd) => {
                              const r = row.schedule.find((x) => x.weekday === wd);
                              const elsewhere = p.schedule.filter((x) => x.weekday === wd);
                              return (
                                <div key={wd} className="w-36 rounded-md border border-zinc-200 p-2 text-xs">
                                  <label className="flex items-center gap-1 font-medium">
                                    <input
                                      type="checkbox"
                                      checked={!!r}
                                      onChange={(e) => {
                                        const h = shopHoursFor(wd);
                                        set({
                                          schedule: e.target.checked
                                            ? [...row.schedule, { weekday: wd, startMin: h?.openMin ?? 9 * 60, endMin: h?.closeMin ?? 17 * 60 }]
                                            : row.schedule.filter((x) => x.weekday !== wd),
                                        });
                                      }}
                                    />
                                    {WEEKDAYS[wd]}
                                  </label>
                                  {r && (
                                    <div className="mt-1 flex gap-1">
                                      <input
                                        type="time"
                                        aria-label={`${p.label} ${WEEKDAYS[wd]} start`}
                                        className="w-full rounded border border-zinc-200 px-1"
                                        value={minutesToHHMM(r.startMin)}
                                        onChange={(e) => set({ schedule: row.schedule.map((x) => (x.weekday === wd ? { ...x, startMin: hhmmToMinutes(e.target.value) } : x)) })}
                                      />
                                      <input
                                        type="time"
                                        aria-label={`${p.label} ${WEEKDAYS[wd]} end`}
                                        className="w-full rounded border border-zinc-200 px-1"
                                        value={minutesToHHMM(r.endMin)}
                                        onChange={(e) => set({ schedule: row.schedule.map((x) => (x.weekday === wd ? { ...x, endMin: hhmmToMinutes(e.target.value) } : x)) })}
                                      />
                                    </div>
                                  )}
                                  {elsewhere.map((x, i) => (
                                    <p key={i} className="mt-1 text-zinc-400">
                                      {x.shop} {minutesToLabel(x.startMin)}–{minutesToLabel(x.endMin)}
                                    </p>
                                  ))}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Field label="Pay calendar" hint="Which bi-weekly calendar this shop's payroll runs on.">
                <Select value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
                  <option value="">The brand&apos;s calendar</option>
                  {options.payCalendars.map((c) => (
                    <option key={c.shopId} value={c.shopId}>
                      Same as {c.shop} (period {c.anchorNumber} starts {c.anchorStart})
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}

          {step === "devices" && (
            <div className="space-y-5">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-zinc-800">Front desk login</legend>
                <label className="flex items-center gap-2 text-sm text-zinc-700">
                  <input type="checkbox" checked={login.on} onChange={(e) => setLogin({ ...login, on: e.target.checked })} /> Create a shared login for this shop&apos;s front desk
                </label>
                {login.on && (
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Name">
                      <Input maxLength={24} placeholder={`${basics.name || "Shop"} desk`.slice(0, 24)} value={login.label} onChange={(e) => setLogin({ ...login, label: e.target.value })} />
                    </Field>
                    <Field label="Sign-in email">
                      <Input type="email" value={login.email} onChange={(e) => setLogin({ ...login, email: e.target.value })} />
                    </Field>
                    <Field label="What it can do">
                      <Select value={login.roleId} onChange={(e) => setLogin({ ...login, roleId: e.target.value })}>
                        {options.loginRoles.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                )}
              </fieldset>
              {network && (
                <fieldset className="space-y-2 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200">
                  <legend className="px-1 text-sm font-semibold text-zinc-800">Where staff can sign in</legend>
                  <NetworkRuleFields value={signIn} onChange={setSignIn} myIp={network.myIp} exempt={network.exempt} shopName={basics.name || "this location"} />
                  <p className="text-xs text-zinc-500">Trusted devices are approved once the location exists, under Sign-in security.</p>
                </fieldset>
              )}
              <Field label="Shop line (Twilio number)" hint="Buy the number in Twilio and point its webhooks here (see the deploy guide). Texts and calls to and from clients use it; leave blank to use the brand's sender for now.">
                <Input placeholder="+13195550123" value={line} onChange={(e) => setLine(e.target.value)} />
              </Field>
            </div>
          )}

          {step === "brand" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Accent color" hint="For this location's booking page. Blank uses the brand's.">
                <div className="flex items-center gap-2">
                  <input type="color" aria-label="Accent color" value={brand.accent || "#1f2937"} onChange={(e) => setBrand({ ...brand, accent: e.target.value })} />
                  <Input className="w-32" value={brand.accent} placeholder="#1f2937" onChange={(e) => setBrand({ ...brand, accent: e.target.value })} />
                </div>
              </Field>
              <Field label="Logo web address" hint="A square PNG or SVG.">
                <Input type="url" value={brand.logo} onChange={(e) => setBrand({ ...brand, logo: e.target.value })} />
              </Field>
              <Field label="About this location" hint="One or two sentences on the booking page." className="sm:col-span-2">
                <Textarea rows={3} value={brand.description} onChange={(e) => setBrand({ ...brand, description: e.target.value })} />
              </Field>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-3 text-sm text-zinc-700">
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                <Item k="Location" v={`${basics.name || "—"} · /book/${basics.slug || "—"}`} />
                <Item k="Address" v={[basics.address, basics.city, basics.state, basics.zip].filter(Boolean).join(", ") || "—"} />
                <Item k="Open" v={hours.filter((h) => h.open).map((h) => WEEKDAYS[h.weekday]).join(", ") || "No days"} />
                <Item k="Closed days" v={holidays.filter((h) => h.date).length ? `${holidays.filter((h) => h.date).length}` : "None"} />
                <Item k="Tax" v={`Services ${money.service}%, products ${money.product}%${money.verified ? "" : " (flagged until confirmed)"}`} />
                <Item k="Card money" v={PAYMENTS_MODE_LABEL[canBank ? pay.mode : "connected"]} />
                <Item k="Card fee" v={pay.mode === "cash_only" ? "No cards" : money.feeOn ? `${money.fee}%${money.feeOnTip ? ", on tips too" : ""}` : "Off"} />
                <Item
                  k="Customer screen"
                  v={`${describeTips(screen.own ? screen.tips : options.brandTips)}${screen.rules.tipEntry === "reader" ? ", tips on the reader" : ""}${screen.rules.signature ? ", signature" : ""}, ${screen.rules.unlock === "manager" ? "manager" : "staff"} PIN`}
                />
                <Item k="Services" v={`${menu.filter((m) => m.enabled).length} of ${menu.length}`} />
                <Item k="Products" v={`${retail.filter((r) => r.include).length}`} />
                <Item k="Vendors" v={`${Object.keys(vendorPicks).length || "Any"}`} />
                <Item k="Team" v={team.map((t) => options.staff.find((s) => s.id === t.staffId)?.label).join(", ") || "Nobody yet"} />
                <Item k="Front desk login" v={login.on && login.email ? login.email : "None"} />
                <Item k="Staff sign-in" v={network && signIn.enabled ? REQUIREMENT_LABEL[signIn.require] : "From anywhere"} />
                <Item k="Shop line" v={line || "Brand sender"} />
                <Item
                  k="Card readers"
                  v={`${readers.filter((r) => r.label.trim()).length}${readers.some((r) => r.label.trim() && r.registrationCode.trim()) ? `, ${readers.filter((r) => r.label.trim() && r.registrationCode.trim()).length} registered on save` : ""}`}
                />
              </dl>
              <Notice tone="blue">The location is created in setup: hidden from the website, the app and online booking until you press Go live on its checklist.</Notice>
              {error && (
                <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-red-700">
                  {error}
                </p>
              )}
              <Button disabled={pending} onClick={submit}>
                {pending ? "Creating…" : "Create location"}
              </Button>
            </div>
          )}
        </div>
        <div className="flex justify-between border-t border-zinc-100 px-4 py-3">
          <Button variant="ghost" disabled={index === 0} onClick={() => go(-1)}>
            Back
          </Button>
          {step !== "review" && <Button onClick={() => go(1)}>Next</Button>}
        </div>
      </Card>
    </div>
  );
}

function Item({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
