"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Select, cx } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { ACCOUNT_STATE_LABEL, AccountState, OWNER_KIND_LABEL, requirementLabel } from "@/domain/connect";
import {
  completeSimulatedOnboardingAction,
  expressDashboardAction,
  refreshPaymentsAccountAction,
  saveOwnerEntityAction,
  setShopOwnerAction,
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

export function OwnerPicker({ shopId, ownerId, owners }: { shopId: string; ownerId: string | null; owners: { id: string; name: string; kind: string }[] }) {
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
            {o.name} · {OWNER_KIND_LABEL[o.kind as keyof typeof OWNER_KIND_LABEL] ?? o.kind}
          </option>
        ))}
      </Select>
      {pending && <span className="text-xs text-zinc-400">Saving…</span>}
      <Problem error={error} />
    </div>
  );
}

export function PaymentsPanel({
  shopId,
  shopName,
  state,
  mode,
  account,
  fees,
  expired,
}: {
  shopId: string;
  shopName: string;
  state: AccountState;
  mode: "stripe" | "simulator";
  account: { stripeAccountId: string; simulated: boolean; requirementsDue: string[]; disabledReason: string | null; chargesEnabled: boolean; payoutsEnabled: boolean } | null;
  fees: { keyed: string; terminal: string };
  expired: boolean;
}) {
  const { pending, error, run } = useAction();
  const go = (fn: () => ReturnType<typeof startPaymentsOnboardingAction>) =>
    run(fn, (d) => {
      if (/^https?:\/\//.test(d.url)) window.location.assign(d.url);
      else window.location.href = d.url;
    });
  const due = [...new Set((account?.requirementsDue ?? []).map(requirementLabel))];
  const startLabel =
    state === "not_started" || state === "disconnected" ? "Set up card payments with Stripe" : account?.chargesEnabled ? "Add the missing details" : "Continue Stripe onboarding";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <AccountStateBadge state={state} />
        {account && <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-600">{account.stripeAccountId}</code>}
        {mode === "simulator" && <Badge tone="violet">Simulator: no Stripe keys yet</Badge>}
      </div>
      {expired && <p className="text-sm text-amber-800">That onboarding link expired or was already used. Continue to get a fresh one.</p>}
      <p className="text-sm text-zinc-600">
        {shopName} gets its own Stripe account. Card charges are made by Ray&apos;z on {shopName}&apos;s behalf and settle there, with tips and surcharges; refunds come back out of
        it, and payouts go to {shopName}&apos;s bank. Clients&apos; saved cards work at every shop. Processing is passed on at {fees.keyed} keyed or online and {fees.terminal} on
        the card reader, and isn&apos;t returned on refunds.
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
        {state !== "enabled" && (
          <Button disabled={pending} onClick={() => go(() => startPaymentsOnboardingAction(shopId))}>
            {pending ? "Opening Stripe…" : startLabel}
          </Button>
        )}
        {account && mode === "stripe" && !account.simulated && (
          <>
            <Button variant="secondary" disabled={pending} onClick={() => run(() => refreshPaymentsAccountAction(shopId))}>
              Refresh status
            </Button>
            {state !== "not_started" && state !== "onboarding" && (
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
                Open the shop&apos;s Stripe dashboard
              </Button>
            )}
          </>
        )}
      </div>
      <Problem error={error} />
    </div>
  );
}

export function SimulatedOnboardingForm({ shopId, shopName }: { shopId: string; shopName: string }) {
  const router = useRouter();
  const { pending, error, run } = useAction();
  const [bank, setBank] = useState(true);
  const submit = () =>
    run(
      () => completeSimulatedOnboardingAction(shopId, bank),
      () => router.push(`/admin/setup?shop=${shopId}&step=payments&stripe=return`),
    );
  return (
    <Card>
      <CardHeader
        title={`Stripe onboarding for ${shopName}`}
        subtitle="With keys, this is Stripe's own hosted form: business details, the owner's identity, and the bank account for payouts."
      />
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Business type">
          <Select defaultValue="company" disabled>
            <option value="company">Company (LLC)</option>
          </Select>
        </Field>
        <Field label="EIN" hint="Stripe's test value">
          <Input defaultValue="000000000" disabled />
        </Field>
        <Field label="Representative">
          <Input defaultValue="Test Representative" disabled />
        </Field>
        <Field label="Date of birth" hint="Stripe's test value">
          <Input defaultValue="1901-01-01" disabled />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={bank} onChange={(e) => setBank(e.target.checked)} className="h-4 w-4 rounded border-zinc-300" />
          Add the test bank account (routing 110000000, account 000123456789) so payouts can start
        </label>
      </div>
      <div className="flex items-center gap-3 border-t border-zinc-100 px-4 py-3">
        <Button disabled={pending} onClick={submit}>
          {pending ? "Submitting…" : "Submit"}
        </Button>
        <Button variant="ghost" onClick={() => router.push(`/admin/setup?shop=${shopId}&step=payments`)}>
          Back without finishing
        </Button>
        <Problem error={error} />
      </div>
    </Card>
  );
}

export function OwnerEditor({
  owner,
  canEdit,
}: {
  owner: { id: string; name: string; legalName: string | null; kind: string; contactEmail: string | null } | null;
  canEdit: boolean;
}) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({
    name: owner?.name ?? "",
    legalName: owner?.legalName ?? "",
    kind: (owner?.kind ?? "franchisee") as "brand" | "franchisee",
    contactEmail: owner?.contactEmail ?? "",
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
        <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="Quad Cities Cuts LLC" />
      </Field>
      <Field label="Legal name" hint="As registered, if different">
        <Input value={v.legalName} onChange={(e) => setV({ ...v, legalName: e.target.value })} />
      </Field>
      <Field label="Kind">
        <Select value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as "brand" | "franchisee" })}>
          <option value="brand">{OWNER_KIND_LABEL.brand}</option>
          <option value="franchisee">{OWNER_KIND_LABEL.franchisee}</option>
        </Select>
      </Field>
      <Field label="Contact email">
        <Input type="email" value={v.contactEmail} onChange={(e) => setV({ ...v, contactEmail: e.target.value })} />
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
