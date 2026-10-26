"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardHeader, Field, Input, Notice, Select, Table, Td, Textarea, Th } from "@/components/ui";
import { type CheckoutPromptSettings, PROMPT_KINDS, PROMPT_LABEL, PROMPT_MODES, PROMPT_MODE_LABEL, type PromptKind, type PromptMode, RULE_TARGET_LABEL, type RuleTarget, ruleTarget } from "@/domain/checkout-prompts";
import { SyncMsg, useSyncSave } from "@/components/brand-sync";
import { setPromptRuleAction } from "./actions";

type Named = { id: string; name: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: string };

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const act = <T,>(fn: () => Promise<Result<T>>, done?: string) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await fn();
      if (!r.ok) setError(r.error);
      else {
        if (done) setSaved(done);
        router.refresh();
      }
    });
  return { pending, error, saved, act };
}

export function PromptSettingsCard({ settings }: { settings: CheckoutPromptSettings }) {
  const [s, setS] = useState(settings);
  const [reasons, setReasons] = useState(settings.rebook.reasons.join("\n"));
  const { pending, msg, save: sync, dialog } = useSyncSave();
  const rb = (patch: Partial<CheckoutPromptSettings["rebook"]>) => setS((x) => ({ ...x, rebook: { ...x.rebook, ...patch } }));
  const pr = (patch: Partial<CheckoutPromptSettings["product"]>) => setS((x) => ({ ...x, product: { ...x.product, ...patch } }));
  const save = () =>
    sync({
      label: "Checkout prompts",
      changes: [
        {
          type: "checkout_prompts",
          item: "brand",
          value: {
            ...s,
            rebook: {
              ...s.rebook,
              reasons: reasons
                .split("\n")
                .map((r) => r.trim())
                .filter(Boolean),
            },
          },
        },
      ],
    });
  return (
    <Card>
      <CardHeader title="Brand defaults" subtitle="Every location, role and barber, unless an override below says otherwise." action={<Button onClick={save} disabled={pending}>Save</Button>} />
      <div className="grid gap-6 p-4 md:grid-cols-2">
        <div className="space-y-3" data-testid="rebook-settings">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Rebook prompt</h3>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.rebook.enabled} onChange={(e) => rb({ enabled: e.target.checked })} /> On
            </label>
          </div>
          <Field label="Answering it">
            <Select value={s.rebook.mode} onChange={(e) => rb({ mode: e.target.value as PromptMode })}>
              {PROMPT_MODES.map((m) => (
                <option key={m} value={m}>
                  {PROMPT_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Times offered">
              <Select value={s.rebook.options} onChange={(e) => rb({ options: Number(e.target.value) })}>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </Select>
            </Field>
            <Field label="Default interval (days)" hint="For a client with no history and a service with no interval">
              <Input type="number" min={7} max={182} value={s.rebook.defaultDays} onChange={(e) => rb({ defaultDays: Number(e.target.value) })} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.rebook.reminders} onChange={(e) => rb({ reminders: e.target.checked })} /> Staff can set a reminder to book when the client says no
          </label>
          {s.rebook.reminders && (
            <Field label="Reminder goes (days before they're due)">
              <Input type="number" min={0} max={14} value={s.rebook.reminderLeadDays} onChange={(e) => rb({ reminderLeadDays: Number(e.target.value) })} />
            </Field>
          )}
          <Field label="Reasons to pick from when they don't book" hint="One per line. Picking one is optional.">
            <Textarea rows={5} value={reasons} onChange={(e) => setReasons(e.target.value)} />
          </Field>
        </div>
        <div className="space-y-3" data-testid="product-settings">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Product prompt</h3>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={s.product.enabled} onChange={(e) => pr({ enabled: e.target.checked })} /> On
            </label>
          </div>
          <Field label="Answering it">
            <Select value={s.product.mode} onChange={(e) => pr({ mode: e.target.value as PromptMode })}>
              {PROMPT_MODES.map((m) => (
                <option key={m} value={m}>
                  {PROMPT_MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Products shown">
            <Input type="number" min={1} max={8} value={s.product.max} onChange={(e) => pr({ max: Number(e.target.value) })} />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.product.pastPurchases} onChange={(e) => pr({ pastPurchases: e.target.checked })} /> Include what the client bought before
          </label>
          <p className="text-xs text-zinc-500">Products come from what the barber tags as used on the ticket, the products set for each service below, and past purchases, with this shop&apos;s stock.</p>
        </div>
      </div>
      {msg && <div className="px-4 pb-4">{msg.ok ? <Notice tone="green">{msg.text}</Notice> : <Notice tone="red">{msg.text}</Notice>}</div>}
      {dialog}
    </Card>
  );
}

export function PromptRulesCard(props: { rules: { id: string; prompt: PromptKind; shopId: string | null; roleId: string | null; staffId: string | null; enabled: boolean }[]; shops: Named[]; roles: Named[]; barbers: Named[] }) {
  const { pending, error, act } = useAct();
  const [prompt, setPrompt] = useState<PromptKind>("rebook");
  const [target, setTarget] = useState<RuleTarget>("location");
  const [targetId, setTargetId] = useState("");
  const [enabled, setEnabled] = useState("off");
  const lists: Record<RuleTarget, Named[]> = { location: props.shops, role: props.roles, barber: props.barbers };
  const nameOf = (r: (typeof props.rules)[number]) => {
    const t = ruleTarget(r);
    const id = r.staffId ?? r.roleId ?? r.shopId;
    return lists[t].find((x) => x.id === id)?.name ?? "—";
  };
  return (
    <Card>
      <CardHeader title="Overrides" subtitle="Turn a prompt on or off for one location, for everyone with a role (whoever is signed in at checkout), or for one barber's tickets." />
      <div className="space-y-3 p-4">
        {props.rules.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Prompt</Th>
                <Th>For</Th>
                <Th>Shown</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {props.rules.map((r) => (
                <tr key={r.id}>
                  <Td>{PROMPT_LABEL[r.prompt]}</Td>
                  <Td>
                    <span className="text-zinc-500">
                      {RULE_TARGET_LABEL[ruleTarget(r)]}:
                    </span>{" "}
                    {nameOf(r)}
                  </Td>
                  <Td>{r.enabled ? <Badge tone="green">On</Badge> : <Badge tone="gray">Off</Badge>}</Td>
                  <Td right>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => act(() => setPromptRuleAction({ prompt: r.prompt, target: ruleTarget(r), targetId: (r.staffId ?? r.roleId ?? r.shopId)!, enabled: null }))}
                    >
                      Remove
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="text-sm text-zinc-500">No overrides: the brand defaults apply everywhere.</p>
        )}
        <div className="grid gap-2 sm:grid-cols-[110px_110px_1fr_90px_auto]" data-testid="add-rule">
          <Select value={prompt} onChange={(e) => setPrompt(e.target.value as PromptKind)} aria-label="Prompt">
            {PROMPT_KINDS.map((k) => (
              <option key={k} value={k}>
                {PROMPT_LABEL[k]}
              </option>
            ))}
          </Select>
          <Select value={target} onChange={(e) => (setTarget(e.target.value as RuleTarget), setTargetId(""))} aria-label="Applies to">
            {(Object.keys(RULE_TARGET_LABEL) as RuleTarget[]).map((t) => (
              <option key={t} value={t}>
                {RULE_TARGET_LABEL[t]}
              </option>
            ))}
          </Select>
          <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="Which">
            <option value="">Pick…</option>
            {lists[target].map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
          <Select value={enabled} onChange={(e) => setEnabled(e.target.value)} aria-label="On or off">
            <option value="on">On</option>
            <option value="off">Off</option>
          </Select>
          <Button disabled={!targetId || pending} onClick={() => act(() => setPromptRuleAction({ prompt, target, targetId, enabled: enabled === "on" }))}>
            Add
          </Button>
        </div>
        {error && <Notice tone="red">{error}</Notice>}
      </div>
    </Card>
  );
}

export function ServicePromptsCard(props: { services: { id: string; name: string; category: string; rebookDays: number | null; productIds: string[] }[]; products: { id: string; name: string; brand: string }[]; defaultDays: number }) {
  return (
    <Card>
      <CardHeader title="Services" subtitle="Each service's rebook interval, for clients who don't have a usual interval yet, and the products suggested whenever it's on the ticket." />
      <Table>
        <thead>
          <tr>
            <Th>Service</Th>
            <Th>Rebook every (days)</Th>
            <Th>Suggested products</Th>
          </tr>
        </thead>
        <tbody>
          {props.services.map((s) => (
            <ServiceRow key={s.id} service={s} products={props.products} defaultDays={props.defaultDays} />
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function ServiceRow({ service, products, defaultDays }: { service: { id: string; name: string; category: string; rebookDays: number | null; productIds: string[] }; products: { id: string; name: string; brand: string }[]; defaultDays: number }) {
  const { pending, msg, save, dialog } = useSyncSave();
  const [days, setDays] = useState(service.rebookDays?.toString() ?? "");
  const [pick, setPick] = useState("");
  const label = (id: string) => {
    const p = products.find((x) => x.id === id);
    return p ? `${p.brand} ${p.name}` : "Product";
  };
  const n = days.trim() ? Number(days) : null;
  const send = (
    value: { rebookDays?: number | null; productIds?: string[] },
    what: string,
    onDone?: () => void,
  ) =>
    save({
      label: `${service.name}: ${what}`,
      changes: [{ type: "service_rule", item: `suggest:${service.id}`, value }],
      onDone: () => onDone?.(),
    });
  return (
    <tr>
      <Td>
        <div className="font-medium">{service.name}</div>
        <div className="text-xs text-zinc-500">{service.category}</div>
      </Td>
      <Td>
        <div className="flex items-center gap-1">
          <Input
            className="w-24"
            type="number"
            min={7}
            max={182}
            placeholder={`${defaultDays}`}
            value={days}
            onChange={(e) => setDays(e.target.value)}
            aria-label={`${service.name} rebook days`}
          />
          {n !== service.rebookDays && (
            <Button
              size="sm"
              variant="secondary"
              disabled={pending}
              onClick={() => send({ rebookDays: n }, "rebook days")}
            >
              Save
            </Button>
          )}
        </div>
      </Td>
      <Td>
        <div className="flex flex-wrap items-center gap-1">
          {service.productIds.map((id) => (
            <button
              key={id}
              disabled={pending}
              onClick={() =>
                send(
                  { productIds: service.productIds.filter((x) => x !== id) },
                  `remove ${label(id)}`,
                )
              }
              className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-800 ring-1 ring-blue-200 hover:bg-blue-100"
              title="Remove"
            >
              {label(id)} ×
            </button>
          ))}
          <Select className="max-w-52 py-1 text-xs" value={pick} onChange={(e) => setPick(e.target.value)} aria-label={`Add a product to ${service.name}`}>
            <option value="">Add a product…</option>
            {products
              .filter((p) => !service.productIds.includes(p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.brand} {p.name}
                </option>
              ))}
          </Select>
          <Button
            size="sm"
            variant="secondary"
            disabled={!pick || pending}
            onClick={() =>
              send(
                { productIds: [...service.productIds, pick] },
                `suggest ${label(pick)}`,
                () => setPick(""),
              )
            }
          >
            Add
          </Button>
        </div>
        <SyncMsg msg={msg} className="mt-1 block" />
        {dialog}
      </Td>
    </tr>
  );
}
