"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Select, cx } from "@/components/ui";
import { LEVELS, LEVEL_LABEL, type Level, type LookupLimits } from "@/domain/client-privacy";
import { acknowledgeAlertAction, saveCustomFieldAction, saveLookupLimitsAction, setFieldRuleAction } from "./actions";

type Rule = { field: string; roleId: string | null; staffId: string | null; shopId: string | null };
type Result = { ok: true; data: unknown } | { ok: false; error: string };

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });
  return { pending, error, run };
}

const TONE: Record<Level, string> = {
  hidden: "bg-red-50 text-red-800 ring-red-200",
  masked: "bg-amber-50 text-amber-900 ring-amber-200",
  full: "bg-emerald-50 text-emerald-900 ring-emerald-200",
};

/** One role × field: a level set here, or inherit the brand default / built-in default. */
export function RuleCell({ rule, level, inherited, from }: { rule: Rule; level: Level | null; inherited: Level; from: string }) {
  const { pending, error, run } = useRun();
  const shown = level ?? inherited;
  return (
    <div>
      <select
        aria-label={`${rule.field} level`}
        disabled={pending}
        value={level ?? ""}
        onChange={(e) => run(() => setFieldRuleAction({ ...rule, level: (e.target.value || null) as Level | null }))}
        className={cx("h-8 rounded-md px-1.5 text-xs ring-1", TONE[shown], !level && "border-dashed opacity-80")}
      >
        <option value="">
          {LEVEL_LABEL[inherited]} ({from})
        </option>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </select>
      {error && <div className="mt-1 max-w-40 whitespace-normal text-[11px] text-red-600">{error}</div>}
    </div>
  );
}

export function RemoveRule({ rule }: { rule: Rule }) {
  const { pending, error, run } = useRun();
  return (
    <>
      <button className="text-xs underline" disabled={pending} onClick={() => run(() => setFieldRuleAction({ ...rule, level: null }))}>
        Remove
      </button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </>
  );
}

export function PersonRuleForm({
  people,
  fields,
  shops,
}: {
  people: { id: string; label: string }[];
  fields: { key: string; label: string }[];
  shops: { id: string; name: string }[];
}) {
  const { pending, error, run } = useRun();
  const [staffId, setStaffId] = useState("");
  const [field, setField] = useState(fields[0]?.key ?? "phone");
  const [shopId, setShopId] = useState("");
  const [level, setLevel] = useState<Level>("hidden");
  return (
    <div className="grid gap-2 border-t border-zinc-100 p-4 sm:grid-cols-5">
      <Select aria-label="Person" value={staffId} onChange={(e) => setStaffId(e.target.value)}>
        <option value="">Person…</option>
        {people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      <Select aria-label="Field" value={field} onChange={(e) => setField(e.target.value)}>
        {fields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
      </Select>
      <Select aria-label="Where" value={shopId} onChange={(e) => setShopId(e.target.value)}>
        <option value="">All shops</option>
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Select aria-label="Level" value={level} onChange={(e) => setLevel(e.target.value as Level)}>
        {LEVELS.map((l) => (
          <option key={l} value={l}>
            {LEVEL_LABEL[l]}
          </option>
        ))}
      </Select>
      <Button disabled={pending || !staffId} onClick={() => run(() => setFieldRuleAction({ field, roleId: null, staffId, shopId: shopId || null, level }))}>
        Add rule
      </Button>
      {error && <p className="text-sm text-red-600 sm:col-span-5">{error}</p>}
    </div>
  );
}

export function CustomFields({ fields }: { fields: { id: string; label: string; active: boolean }[] }) {
  const { pending, error, run } = useRun();
  const [label, setLabel] = useState("");
  return (
    <div>
      <ul className="divide-y divide-zinc-100 text-sm">
        {fields.map((f) => (
          <li key={f.id} className="flex items-center justify-between px-4 py-2">
            <span className={f.active ? "" : "text-zinc-400 line-through"}>{f.label}</span>
            <button className="text-xs underline" disabled={pending} onClick={() => run(() => saveCustomFieldAction({ id: f.id, label: f.label, active: !f.active }))}>
              {f.active ? "Turn off" : "Turn on"}
            </button>
          </li>
        ))}
        {fields.length === 0 && <li className="px-4 py-3 text-xs text-zinc-500">No custom fields yet.</li>}
      </ul>
      <div className="flex gap-2 border-t border-zinc-100 p-4">
        <Input placeholder="New field, e.g. Instagram" value={label} onChange={(e) => setLabel(e.target.value)} />
        <Button
          disabled={pending || label.trim().length < 2}
          onClick={() =>
            run(
              () => saveCustomFieldAction({ id: null, label, active: true }),
              () => setLabel(""),
            )
          }
        >
          Add
        </Button>
      </div>
      {error && <p className="px-4 pb-3 text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function LimitsForm({ initial }: { initial: LookupLimits }) {
  const { pending, error, run } = useRun();
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const num = (k: keyof LookupLimits) => <Input type="number" min={1} value={v[k]} onChange={(e) => (setSaved(false), setV({ ...v, [k]: Number(e.target.value) }))} />;
  return (
    <div className="grid grid-cols-2 gap-3 p-4">
      <Field label="Time window (minutes)" className="col-span-2">
        {num("windowMinutes")}
      </Field>
      <Field label="Alert after profiles opened">{num("alertProfiles")}</Field>
      <Field label="Pause after profiles opened">{num("blockProfiles")}</Field>
      <Field label="Alert after searches">{num("alertSearches")}</Field>
      <Field label="Pause after searches">{num("blockSearches")}</Field>
      <div className="col-span-2 flex items-center gap-3">
        <Button
          disabled={pending}
          onClick={() =>
            run(
              () => saveLookupLimitsAction(v),
              () => setSaved(true),
            )
          }
        >
          Save limits
        </Button>
        {saved && <span className="text-sm text-zinc-600">Saved</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export function AcknowledgeAlert({ id }: { id: string }) {
  const { pending, error, run } = useRun();
  return (
    <>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => acknowledgeAlertAction(id))}>
        Acknowledge
      </Button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </>
  );
}
