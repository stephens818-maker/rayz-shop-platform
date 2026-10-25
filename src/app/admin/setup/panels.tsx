"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Select, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import {
  ACCOUNT_STATE_LABEL,
  AccountState,
  OWNER_KIND_LABEL,
  PAYMENTS_MODES,
  PAYMENTS_MODE_HINT,
  PAYMENTS_MODE_LABEL,
  PAYMENTS_STEP_TITLE,
  descriptorSuffix,
  requirementLabel,
  statementDescriptorProblem,
  type PaymentsMode,
} from "@/domain/connect";
import {
  archiveLocationAction,
  closeLocationAction,
  goLiveAction,
  reopenLocationAction,
  completeSimulatedEntityOnboardingAction,
  completeSimulatedOnboardingAction,
  deleteRegionAction,
  entityDashboardAction,
  expressDashboardAction,
  refreshEntityAccountAction,
  refreshPaymentsAccountAction,
  saveOwnerEntityAction,
  saveRegionAction,
  saveStatementDescriptorAction,
  setPaymentsModeAction,
  setShopOwnerAction,
  setShopRegionAction,
  startEntityOnboardingAction,
  startPaymentsOnboardingAction,
} from "./actions";

export const STATE_TONE: Record<AccountState, "gray" | "amber" | "blue" | "red" | "green"> = {
  not_started: "gray",
  onboarding: "amber",
  in_review: "blue",
  restricted: "red",
  enabled: "green",
  disconnected: "red",
};

export function AccountStateBadge({ state }: { state: AccountState }) {
  return <Badge tone={STATE_TONE[state]}>{ACCOUNT_STATE_LABEL[state]}</Badge>;
}

function Problem({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-red-600">
      {error}
    </p>
  ) : null;
}

export function OwnerPicker({ shopId, ownerId, owners }: { shopId: string; ownerId: string | null; owners: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [shown, setShown] = useState(ownerId ?? "");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="sr-only" htmlFor={`owner-${shopId}`}>
        Owner
      </label>
      <Select
        id={`owner-${shopId}`}
        className="w-80 max-w-full"
        value={shown}
        disabled={pending}
        onChange={(e) => {
          const prev = shown;
          setShown(e.target.value);
          run(async () => {
            const r = await setShopOwnerAction(shopId, e.target.value);
            if (!r.ok) setShown(prev);
            return r;
          });
        }}
      >
        {!ownerId && <option value="">Choose an owner…</option>}
        {owners.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </Select>
      {pending && <span className="text-xs text-zinc-400">Saving…</span>}
      <Problem error={error} />
    </div>
  );
}

export function RegionPicker({ shopId, shopName, regionId, regions }: { shopId: string; shopName: string; regionId: string | null; regions: { id: string; name: string }[] }) {
  const { pending, error, run } = useAction();
  const [shown, setShown] = useState(regionId ?? "");
  return (
    <div>
      <Select
        aria-label={`Region for ${shopName}`}
        className="w-40"
        value={shown}
        disabled={pending}
        onChange={(e) => {
          const prev = shown;
          setShown(e.target.value);
          run(async () => {
            const r = await setShopRegionAction(shopId, e.target.value || null);
            if (!r.ok) setShown(prev);
            return r;
          });
        }}
      >
        <option value="">No region</option>
        {regions.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
          </option>
        ))}
      </Select>
      <Problem error={error} />
    </div>
  );
}

export function RegionsEditor({ regions, canEdit }: { regions: { id: string; name: string; shops: { id: string; name: string }[] }[]; canEdit: boolean }) {
  const { pending, error, run } = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const open = (id: string, current: string) => {
    setEditing(id);
    setName(current);
  };
  const form = (id: string | null) => (
    <div className="flex flex-wrap items-center gap-2">
      <Input aria-label="Region name" className="w-56" maxLength={60} value={name} placeholder="Quad Cities" onChange={(e) => setName(e.target.value)} />
      <Button size="sm" disabled={pending || !name.trim()} onClick={() => run(() => saveRegionAction(id, name), () => setEditing(null))}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
        Cancel
      </Button>
    </div>
  );
  return (
    <Card>
      <CardHeader
        title="Regions"
        subtitle="Optional groups of locations for the Location comparison report, e.g. a metro area or a district manager's patch. Pick each location's region in the table above."
        action={canEdit && editing !== "new" && (
          <Button size="sm" variant="secondary" onClick={() => open("new", "")}>
            Add a region
          </Button>
        )}
      />
      <ul className="divide-y divide-zinc-100">
        {editing === "new" && <li className="px-4 py-3">{form(null)}</li>}
        {regions.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            {editing === r.id ? (
              form(r.id)
            ) : (
              <>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-zinc-900">{r.name}</div>
                  <div className="mt-0.5 text-sm text-zinc-500">{r.shops.length ? r.shops.map((s) => s.name).join(", ") : "No locations yet"}</div>
                </div>
                {canEdit && (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => open(r.id, r.name)}>
                      Rename
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-red-700"
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm(`Delete ${r.name}? Its ${r.shops.length} location${r.shops.length === 1 ? "" : "s"} will have no region.`)) run(() => deleteRegionAction(r.id));
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
        {regions.length === 0 && editing !== "new" && <li className="px-4 py-6 text-center text-sm text-zinc-500">No regions. Every location is compared on its own.</li>}
      </ul>
      {error && (
        <div className="px-4 pb-3">
          <Problem error={error} />
        </div>
      )}
    </Card>
  );
}

export function PaymentsPanel({
  shopId,
  shopName,
  state,
  mode,
  paymentsMode,
  canBank,
  account,
  fees,
  expired,
  descriptor,
  descriptorPrefix,
  payoutSchedule,
  terminalLocationId,
  readers,
  owner,
}: {
  shopId: string;
  shopName: string;
  /** The shop's owner entity and its own account, for payments mode "entity". */
  owner: { name: string; stripeAccountId: string | null } | null;
  state: AccountState;
  mode: "stripe" | "simulator";
  paymentsMode: PaymentsMode;
  canBank: boolean;
  account: { stripeAccountId: string; simulated: boolean; requirementsDue: string[]; disabledReason: string | null; chargesEnabled: boolean; payoutsEnabled: boolean } | null;
  fees: { keyed: string; terminal: string };
  expired: boolean;
  descriptor: string | null;
  descriptorPrefix: string;
  payoutSchedule: string;
  terminalLocationId: string | null;
  readers: number;
}) {
  const { pending, error, run } = useAction();
  const [choice, setChoice] = useState<PaymentsMode>(paymentsMode);
  const [desc, setDesc] = useState(descriptor ?? "");
  const go = (fn: () => ReturnType<typeof startPaymentsOnboardingAction>) =>
    run(fn, (d) => {
      if (/^https?:\/\//.test(d.url)) window.location.assign(d.url);
      else window.location.href = d.url;
    });
  const due = [...new Set((account?.requirementsDue ?? []).map(requirementLabel))];
  const startLabel =
    state === "not_started" || state === "disconnected" ? "Set up card payments with Stripe" : account?.chargesEnabled ? "Add the missing details" : "Continue Stripe onboarding";
  const descIssue = desc.trim() ? statementDescriptorProblem(desc.trim().toUpperCase()) : null;
  const suffix = paymentsMode === "brand" && descriptor ? descriptorSuffix(descriptor, descriptorPrefix) : null;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-zinc-800">Where {shopName}&apos;s card money goes</legend>
        {PAYMENTS_MODES.map((m) => (
          <label key={m} className={cx("flex items-start gap-2 rounded-lg border p-2.5 text-sm", choice === m ? "border-brand-500 bg-brand-50" : "border-zinc-200", !canBank && "opacity-75")}>
            <input type="radio" name={`mode-${shopId}`} className="mt-1" disabled={!canBank || pending} checked={choice === m} onChange={() => setChoice(m)} />
            <span>
              <span className="font-medium text-zinc-900">{PAYMENTS_MODE_LABEL[m]}</span>
              {m === paymentsMode && <Badge className="ml-2">Current</Badge>}
              <span className="block text-zinc-500">{PAYMENTS_MODE_HINT[m]}</span>
            </span>
          </label>
        ))}
        {canBank && choice !== paymentsMode && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={pending} onClick={() => run(() => setPaymentsModeAction(shopId, choice))}>
              Switch to {PAYMENTS_MODE_LABEL[choice].toLowerCase()}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setChoice(paymentsMode)}>
              Cancel
            </Button>
            <span className="text-xs text-zinc-500">
              New charges follow the switch. Earlier charges stay where they settled, and their refunds come out of that account.
              {choice === "connected" && state !== "enabled" && " Cards stop until Stripe approves the shop's own account."}
              {choice === "entity" && " Cards stop unless the owner's account is approved."}
            </span>
          </div>
        )}
        {!canBank && <p className="text-xs text-zinc-500">Only the Brand Owner, or someone they&apos;ve given the banking permission, can connect or change this.</p>}
      </fieldset>

      {paymentsMode === "connected" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <AccountStateBadge state={state} />
            {account && <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{account.stripeAccountId}</code>}
            {mode === "simulator" && <Badge tone="violet">Simulator: no Stripe keys yet</Badge>}
          </div>
          {expired && <p className="text-sm text-amber-800">That onboarding link expired or was already used. Continue to get a fresh one.</p>}
          <p className="text-sm text-zinc-600">
            {shopName} gets its own Stripe account. Stripe&apos;s own pages collect its legal entity, EIN, owner identity and bank account; Ray&apos;z keeps only the account ID
            and the status Stripe reports. Card charges are made by Ray&apos;z on {shopName}&apos;s behalf and settle there, with tips and surcharges; refunds come back out of it,
            and payouts go to {shopName}&apos;s bank. Clients&apos; saved cards work at every shop. Processing is passed on at {fees.keyed} keyed or online and {fees.terminal} on
            the card reader, and isn&apos;t returned on refunds. Year-end 1099 tax forms for its card sales come from Stripe and appear in the shop&apos;s Stripe dashboard.
          </p>
          {due.length > 0 && state !== "enabled" && (
            <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
              <div className="font-medium">Stripe still needs:</div>
              <ul className="mt-1 list-disc pl-5">
                {due.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </div>
          )}
          {account?.chargesEnabled && !account.payoutsEnabled && <p className="text-sm text-amber-800">Cards work, but payouts wait until Stripe has everything above.</p>}
          <div className="flex flex-wrap gap-2">
            {state !== "enabled" && canBank && (
              <Button disabled={pending} onClick={() => go(() => startPaymentsOnboardingAction(shopId))}>
                {pending ? "Opening Stripe…" : startLabel}
              </Button>
            )}
            {account && mode === "stripe" && !account.simulated && (
              <>
                <Button variant="secondary" disabled={pending} onClick={() => run(() => refreshPaymentsAccountAction(shopId))}>
                  Refresh status
                </Button>
                {canBank && state !== "not_started" && state !== "onboarding" && (
                  <Button
                    variant="ghost"
                    disabled={pending}
                    onClick={() =>
                      run(
                        () => expressDashboardAction(shopId),
                        (d) => window.open(d.url, "_blank", "noopener"),
                      )
                    }
                  >
                    Open the shop&apos;s Stripe dashboard (bank, payouts, tax forms)
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {paymentsMode === "entity" && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <AccountStateBadge state={state} />
            {owner?.stripeAccountId && <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{owner.stripeAccountId}</code>}
          </div>
          <p className="text-sm text-zinc-600">
            {shopName}&apos;s card sales, tips and surcharges settle in {owner?.name ?? "its owner"}&apos;s Stripe account, with every other shop of theirs set to it, and are paid
            out together to the owner&apos;s bank. Refunds come back out of it. Each charge is still tagged with {shopName}, so its sales and fees report on their own. Processing is{" "}
            {fees.keyed} keyed or online and {fees.terminal} on the card reader. Card statements show the owner account&apos;s descriptor.
          </p>
          <p className="text-sm">
            <Link className="font-medium text-brand-700 hover:underline" href="/admin/setup#owners">
              {state === "enabled" ? "The owner's account" : "Set up the owner's account"} under Owners
            </Link>
          </p>
        </div>
      )}
      {paymentsMode === "brand" && (
        <p className="text-sm text-zinc-600">
          {shopName}&apos;s card sales, tips and surcharges settle in the brand&apos;s main Stripe account and are paid out to the brand&apos;s bank with the other brand-account
          shops. Each charge is still tagged with {shopName}, so its sales, refunds and fees report on their own. Processing is {fees.keyed} keyed or online and {fees.terminal} on
          the card reader.
        </p>
      )}
      {paymentsMode === "cash_only" && (
        <p className="text-sm text-zinc-600">
          {shopName} takes cash and gift cards only. Checkout won&apos;t offer cards until you switch it to a Stripe account above.
        </p>
      )}

      {paymentsMode !== "cash_only" && (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Payout schedule (from Stripe)</dt>
            <dd className="text-zinc-800">{payoutSchedule}</dd>
          </div>
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Stripe Terminal location</dt>
            <dd className="text-zinc-800">
              {terminalLocationId ? <code className="text-xs">{terminalLocationId}</code> : "Created when the first reader is registered"} · {readers} reader{readers === 1 ? "" : "s"}
            </dd>
          </div>
          <div className={cx("sm:col-span-2", paymentsMode === "entity" && "hidden")}>
            <dt className="text-xs font-medium uppercase tracking-wide text-zinc-500">Statement descriptor</dt>
            <dd className="text-zinc-800">
              {canBank ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <Input
                    aria-label="Statement descriptor"
                    maxLength={22}
                    className="w-64 uppercase"
                    placeholder={paymentsMode === "brand" ? descriptorPrefix : "Stripe uses the business name"}
                    value={desc}
                    onChange={(e) => setDesc(e.target.value)}
                  />
                  <Button size="sm" variant="secondary" disabled={pending || !!descIssue || desc.trim().toUpperCase() === (descriptor ?? "")} onClick={() => run(() => saveStatementDescriptorAction(shopId, desc || null))}>
                    Save
                  </Button>
                  {descIssue && <span className="text-sm text-red-700">{descIssue}</span>}
                </div>
              ) : (
                descriptor ?? <span className="text-zinc-400">Not set</span>
              )}
              {paymentsMode === "brand" && (
                <span className="mt-1 block text-xs text-zinc-500">
                  Clients see {descriptorPrefix}* {suffix ?? "and nothing after it"} on their statement.
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}
      <p className="text-sm">
        <Link className="font-medium text-brand-700 hover:underline" href={`/admin/settings?shop=${shopId}`}>
          Card fee, tip buttons, card readers and receipts
        </Link>
        <span className="text-zinc-400"> · </span>
        <Link className="font-medium text-brand-700 hover:underline" href={`/admin/payouts?shop=${shopId}`}>
          Payouts and fees
        </Link>
      </p>
      <Problem error={error} />
    </div>
  );
}

/** Either a shop's account (`shopId`) or an owner entity's (`entityId`). */
export function SimulatedOnboardingForm({ shopId, entityId, shopName }: { shopId?: string; entityId?: string; shopName: string }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [bank, setBank] = useState(true);
  const back = entityId ? `/admin/setup?owner=${entityId}` : `/admin/setup?shop=${shopId}&step=payments`;
  const submit = () =>
    run(
      () => (entityId ? completeSimulatedEntityOnboardingAction(entityId, bank) : completeSimulatedOnboardingAction(shopId!, bank)),
      () => router.push(`${back}&stripe=return`),
    );
  return (
    <Card>
      <CardHeader
        title={`Stripe onboarding for ${shopName}`}
        subtitle="With keys, this is Stripe's own hosted page. This app never sees what is entered there."
      />
      <div className="space-y-3 p-4 text-sm">
        <p>Stripe asks for the business details and EIN, the owner&apos;s identity (date of birth, SSN, ID document if needed) and the bank account for payouts, and verifies them.</p>
        <p className="text-zinc-500">We get back only whether the account can take payments and receive payouts, what Stripe still needs, and the bank&apos;s name with the last 4 digits.</p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={bank} onChange={(e) => setBank(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
          Add a test bank account so payouts can start
        </label>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button disabled={pending} onClick={submit}>
          {pending ? "Submitting…" : "Submit"}
        </Button>
        <Button variant="ghost" onClick={() => router.push(back)}>
          Back without finishing
        </Button>
        <Problem error={error} />
      </div>
    </Card>
  );
}

/** An owner entity's own Stripe account, which its shops in payments mode "entity" share. */
export function OwnerAccountPanel({
  entityId,
  ownerName,
  state,
  mode,
  canBank,
  account,
  shopsOn,
  returned,
}: {
  entityId: string;
  ownerName: string;
  state: AccountState;
  mode: "stripe" | "simulator";
  canBank: boolean;
  account: { stripeAccountId: string; simulated: boolean; requirementsDue: string[]; chargesEnabled: boolean; payoutsEnabled: boolean } | null;
  shopsOn: string[];
  returned: boolean;
}) {
  const { pending, error, run } = useAction();
  const due = [...new Set((account?.requirementsDue ?? []).map(requirementLabel))];
  if (!account && !canBank) return null;
  const go = () =>
    run(
      () => startEntityOnboardingAction(entityId),
      (d) => {
        window.location.href = d.url;
      },
    );
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-zinc-200 p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-zinc-800">Owner&apos;s Stripe account</span>
        <AccountStateBadge state={state} />
        {account && <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{account.stripeAccountId}</code>}
      </div>
      {returned && <p className="text-emerald-700">{state === "enabled" ? `${ownerName}'s account can take cards.` : "Stripe has what you entered. Anything it still needs is listed here."}</p>}
      <p className="text-zinc-600">
        Optional: one account for the owner&apos;s legal entity and bank, which any of their shops can settle to instead of its own. Stripe collects the EIN, owners and bank; Ray&apos;z
        keeps only the account ID and status. {shopsOn.length ? `Settling here: ${shopsOn.join(", ")}.` : "No shop settles here yet; choose it in a shop's Payments and banking step."}
      </p>
      {due.length > 0 && state !== "enabled" && <p className="text-amber-800">Stripe still needs: {due.join(", ")}.</p>}
      {canBank && (
        <div className="flex flex-wrap gap-2">
          {state !== "enabled" && (
            <Button size="sm" disabled={pending} onClick={go}>
              {pending ? "Opening Stripe…" : account ? "Continue Stripe onboarding" : "Set up the owner's Stripe account"}
            </Button>
          )}
          {account && mode === "stripe" && !account.simulated && (
            <>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => refreshEntityAccountAction(entityId))}>
                Refresh status
              </Button>
              {state !== "not_started" && state !== "onboarding" && (
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => entityDashboardAction(entityId), (d) => window.open(d.url, "_blank", "noopener"))}>
                  Open the owner&apos;s Stripe dashboard
                </Button>
              )}
            </>
          )}
        </div>
      )}
      <Problem error={error} />
    </div>
  );
}

export function OwnerEditor({
  owner,
  canEdit,
}: {
  owner: { id: string; name: string; legalName: string | null; kind: "brand" | "franchisee"; isDefault: boolean; contactEmail: string | null } | null;
  canEdit: boolean;
}) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    name: owner?.name ?? "",
    legalName: owner?.legalName ?? "",
    contactEmail: owner?.contactEmail ?? "",
    kind: owner?.kind ?? ("franchisee" as "brand" | "franchisee"),
  });
  if (!canEdit) return null;
  if (!open)
    return (
      <Button variant={owner ? "ghost" : "secondary"} size="sm" onClick={() => setOpen(true)}>
        {owner ? "Edit" : "Add an owner"}
      </Button>
    );
  return (
    <div className={cx("grid w-full gap-2 rounded-lg bg-zinc-50 p-3 sm:grid-cols-2", owner && "mt-2")}>
      <Field label="Name">
        <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Ray'z Moline LLC" />
      </Field>
      <Field label="Legal name" hint="As registered, if different">
        <Input value={v.legalName} onChange={(e) => setV({ ...v, legalName: e.target.value })} />
      </Field>
      <Field label="Contact email">
        <Input type="email" value={v.contactEmail} onChange={(e) => setV({ ...v, contactEmail: e.target.value })} />
      </Field>
      <Field label="Kind" hint={owner?.isDefault ? "The default owner of new locations is always Ray'z corporate." : "A franchisee's people can be scoped to its shops."}>
        <Select value={v.kind} disabled={owner?.isDefault} onChange={(e) => setV({ ...v, kind: e.target.value as "brand" | "franchisee" })}>
          {(["brand", "franchisee"] as const).map((k) => (
            <option key={k} value={k}>
              {OWNER_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <div className="flex items-center gap-2 sm:col-span-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveOwnerEntityAction(owner?.id ?? null, { ...v, legalName: v.legalName || null, contactEmail: v.contactEmail || null }),
              () => setOpen(false),
            )
          }
        >
          {pending ? "Saving…" : "Save owner"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Problem error={error} />
      </div>
    </div>
  );
}

export function LifecyclePanel({
  shop,
  blockers,
  paymentsReady,
  canManage,
}: {
  shop: { id: string; name: string; status: "setup" | "live" | "closed" | "archived"; closedUntil: string | null; closedNote: string | null };
  blockers: string[];
  paymentsReady: boolean;
  canManage: boolean;
}) {
  const { pending, error, run } = useAction();
  const [cashOnly, setCashOnly] = useState(false);
  const [closing, setClosing] = useState(false);
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [archiving, setArchiving] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [archived, setArchived] = useState<string | null>(null);
  const waiting = blockers.filter((b) => !(cashOnly && b === PAYMENTS_STEP_TITLE));
  if (!canManage) return null;
  return (
    <Card>
      <CardHeader
        title="Open, close or retire"
        subtitle={
          shop.status === "setup"
            ? "Hidden from the website, the app and online booking. Staff can practice-book and ring up test tickets."
            : shop.status === "live"
              ? "Open to clients."
              : shop.status === "closed"
                ? `Temporarily closed${shop.closedUntil ? ` through ${shop.closedUntil}` : ""}. Clients see it with your note and can't book.`
                : "Archived. Its history stays in every report."
        }
      />
      <div className="space-y-3 px-4 pb-4">
        {shop.status === "setup" && (
          <>
            {waiting.length > 0 && <p className="text-sm text-amber-700">Still to do before go-live: {waiting.join(", ")}.</p>}
            {!paymentsReady && (
              <label className="flex items-center gap-2 text-sm text-zinc-700">
                <input type="checkbox" checked={cashOnly} onChange={(e) => setCashOnly(e.target.checked)} /> Open cash-only for now (cards start on their own once Stripe enables charges)
              </label>
            )}
            <Button disabled={pending || waiting.length > 0} onClick={() => run(() => goLiveAction(shop.id, cashOnly))}>
              Go live
            </Button>
          </>
        )}
        {shop.status === "closed" && (
          <Button disabled={pending} onClick={() => run(() => reopenLocationAction(shop.id))}>
            Reopen now
          </Button>
        )}
        {shop.status === "live" &&
          (closing ? (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Closed through (blank = until reopened)">
                <Input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
              </Field>
              <Field label="What clients are told" className="min-w-64 flex-1">
                <Input value={note} placeholder="Closed for remodeling. See you soon!" onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Button disabled={pending} onClick={() => run(() => closeLocationAction(shop.id, until || null, note || null), () => setClosing(false))}>
                Close temporarily
              </Button>
              <Button variant="ghost" onClick={() => setClosing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setClosing(true)}>
              Close temporarily…
            </Button>
          ))}
        {shop.status !== "archived" &&
          (archiving ? (
            <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
              <p className="text-sm text-red-800">
                Archiving removes {shop.name} from booking, the calendar and every picker, disables its shop logins at once, removes its barbers&apos; hours there and cancels
                messages not yet sent. Its sales, appointments, payroll and stock history stay in reports. Upcoming appointments have to be moved first.
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label={`Type ${shop.name} to confirm`}>
                  <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </Field>
                <Button
                  variant="danger"
                  disabled={pending || confirm.trim().toLowerCase() !== shop.name.toLowerCase()}
                  onClick={() =>
                    run(
                      () => archiveLocationAction(shop.id, confirm),
                      (r) => setArchived(`${r.loginsDisabled} login${r.loginsDisabled === 1 ? "" : "s"} disabled, ${r.schedulesRemoved} schedule rows removed, ${r.messagesCancelled} messages cancelled.`),
                    )
                  }
                >
                  Archive {shop.name}
                </Button>
                <Button variant="ghost" onClick={() => setArchiving(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button variant="ghost" className="text-red-700" onClick={() => setArchiving(true)}>
              Archive this location…
            </Button>
          ))}
        {archived && <p className="text-sm text-emerald-700">Archived. {archived}</p>}
        <Problem error={error} />
      </div>
    </Card>
  );
}
