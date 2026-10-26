"use client";

import { useState } from "react";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Input,
  Notice,
  Select,
  cx,
} from "@/components/ui";
import { SyncMsg } from "@/components/brand-sync";
import { ListShops, useListSync } from "@/components/list-sync";
import { useAction } from "@/components/use-action";
import {
  type BlockReason,
  PICKABLE_USES,
  PRIVATE_BLOCK_LABEL,
  REASON_COLORS,
  type ReasonUse,
  USE_LABEL,
  isHexColor,
} from "@/domain/block-reasons";
import {
  archiveReasonAction,
  moveReasonAction,
  saveReasonAction,
} from "./actions";

type Draft = Pick<
  BlockReason,
  "label" | "color" | "usedFor" | "countsAsLunch" | "noticeExempt" | "private"
>;
const draftOf = (r: BlockReason): Draft => ({
  label: r.label,
  color: r.color,
  usedFor: r.usedFor,
  countsAsLunch: r.countsAsLunch,
  noticeExempt: r.noticeExempt,
  private: r.private,
});
const same = (a: Draft, b: Draft) =>
  (Object.keys(a) as (keyof Draft)[]).every((k) => a[k] === b[k]);
const BLANK: Draft = {
  label: "",
  color: REASON_COLORS[9],
  usedFor: "both",
  countsAsLunch: false,
  noticeExempt: false,
  private: false,
};

export function ReasonsEditor({
  reasons,
  brand,
}: {
  reasons: BlockReason[];
  /** Brand-wide: picks which shops have each reason. */ brand: boolean;
}) {
  const active = reasons.filter((r) => !r.archived);
  const archived = reasons.filter((r) => r.archived);
  return (
    <>
      <Card>
        <CardHeader
          title="Reasons"
          subtitle={`In the order the pickers show them. Private reasons show as "${PRIVATE_BLOCK_LABEL}" (or "Time off") to staff without "See private block and time off reasons", except on their own time.`}
        />
        <ul className="divide-y divide-zinc-100">
          {active.map((r, i) => (
            <ReasonRow
              key={r.id}
              reason={r}
              first={i === 0}
              last={i === active.length - 1}
              brand={brand}
            />
          ))}
        </ul>
        <div className="border-t border-zinc-200 bg-zinc-50/60">
          <NewReason brand={brand} />
        </div>
      </Card>
      {archived.length > 0 && (
        <Card>
          <CardHeader
            title="Archived"
            subtitle="Off the pickers. Entries that already have them keep them."
          />
          <ul className="divide-y divide-zinc-100">
            {archived.map((r) => (
              <ArchivedRow key={r.id} reason={r} />
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function Preview({ d }: { d: Draft }) {
  return (
    <span
      className="shade-reason inline-flex h-8 w-28 items-center truncate rounded-md pl-2.5 pr-1.5 text-[11px] font-semibold text-zinc-900"
      style={{
        ["--reason" as string]: isHexColor(d.color) ? d.color : undefined,
      }}
    >
      {d.label || "Preview"}
    </span>
  );
}

function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (c: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${label} color`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-10 items-center justify-center rounded-lg ring-1 ring-zinc-300"
      >
        <span
          className="size-6 rounded-full"
          style={{ backgroundColor: isHexColor(value) ? value : "#fff" }}
        />
      </button>
      {open && (
        <div className="absolute left-0 top-11 z-30 w-56 space-y-2 rounded-xl bg-white p-3 shadow-lg ring-1 ring-zinc-200">
          <div className="grid grid-cols-6 gap-2">
            {REASON_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={value.toLowerCase() === c}
                onClick={() => (onChange(c), setOpen(false))}
                className={cx(
                  "size-7 rounded-full ring-offset-2",
                  value.toLowerCase() === c && "ring-2 ring-ink-900",
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <Input
            aria-label="Hex color"
            value={value}
            onChange={(e) => onChange(e.target.value.trim())}
            placeholder="#rrggbb"
            maxLength={7}
          />
        </div>
      )}
    </div>
  );
}

function Fields({
  d,
  set,
  name,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  name: string;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
      <ColorPicker
        value={d.color}
        onChange={(color) => set({ color })}
        label={name}
      />
      <Input
        aria-label="Name"
        className="w-40"
        value={d.label}
        maxLength={30}
        onChange={(e) => set({ label: e.target.value })}
        placeholder="e.g. Kid pickup"
      />
      {d.usedFor === "clock" ? (
        <span
          className="text-sm text-zinc-500"
          title="Written by the time clock; no picker offers it"
        >
          {USE_LABEL.clock}
        </span>
      ) : (
        <Select
          aria-label="Used for"
          className="w-auto"
          value={d.usedFor}
          onChange={(e) => set({ usedFor: e.target.value as ReasonUse })}
        >
          {PICKABLE_USES.map((u) => (
            <option key={u} value={u}>
              {USE_LABEL[u]}
            </option>
          ))}
        </Select>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-sm">
        {d.usedFor !== "clock" && (
          <>
            <label
              className="flex items-center gap-1.5"
              title="Held to the shop's longest lunch instead of the longest block; Lunch now uses the first one"
            >
              <input
                type="checkbox"
                checked={d.countsAsLunch}
                onChange={(e) => set({ countsAsLunch: e.target.checked })}
              />{" "}
              Counts as lunch
            </label>
            <label
              className="flex items-center gap-1.5"
              title="Time off for it can be asked for without the shop's minimum notice"
            >
              <input
                type="checkbox"
                checked={d.noticeExempt}
                onChange={(e) => set({ noticeExempt: e.target.checked })}
              />{" "}
              No notice needed
            </label>
          </>
        )}
        <label
          className="flex items-center gap-1.5"
          title={`Staff without "See private reasons" see "${PRIVATE_BLOCK_LABEL}", with no note`}
        >
          <input
            type="checkbox"
            checked={d.private}
            onChange={(e) => set({ private: e.target.checked })}
          />{" "}
          Private
        </label>
      </div>
    </div>
  );
}

function ReasonRow({
  reason,
  first,
  last,
  brand,
}: {
  reason: BlockReason;
  first: boolean;
  last: boolean;
  brand: boolean;
}) {
  const { pending, error, run } = useAction();
  const [d, setD] = useState<Draft>(draftOf(reason));
  const dirty = !same(d, draftOf(reason));
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <button
            className="h-5 px-1 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-30"
            aria-label={`Move ${reason.label} up`}
            disabled={first || pending}
            onClick={() => run(() => moveReasonAction(reason.id, -1))}
          >
            ▲
          </button>
          <button
            className="h-5 px-1 text-xs text-zinc-500 hover:text-zinc-900 disabled:opacity-30"
            aria-label={`Move ${reason.label} down`}
            disabled={last || pending}
            onClick={() => run(() => moveReasonAction(reason.id, 1))}
          >
            ▼
          </button>
        </div>
        <Fields d={d} set={set} name={reason.label} />
        <Preview d={d} />
        {reason.private && !dirty && <Badge tone="violet">private</Badge>}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!dirty || pending}
            onClick={() => run(() => saveReasonAction({ id: reason.id, ...d }))}
          >
            Save
          </Button>
          {dirty && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setD(draftOf(reason))}
            >
              Undo
            </Button>
          )}
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => run(() => archiveReasonAction(reason.id, true))}
          >
            Archive
          </Button>
          {brand && reason.usedFor !== "clock" && (
            <ListShops
              list="block_reason"
              id={reason.id}
              label={reason.label}
              disabled={pending}
            />
          )}
        </div>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </li>
  );
}

function NewReason({ brand }: { brand: boolean }) {
  const { pending, error, run } = useAction();
  const shops = useListSync("block_reason");
  const [d, setD] = useState<Draft>(BLANK);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="text-sm font-medium">Add a reason</div>
      <div className="flex flex-wrap items-center gap-3">
        <Fields d={d} set={set} name="New reason" />
        <Preview d={d} />
        <Button
          size="sm"
          disabled={pending || !d.label.trim()}
          onClick={() =>
            run(
              () => saveReasonAction({ id: null, ...d }),
              (r) => {
                setD(BLANK);
                if (brand) shops.offer(r.id, r.label);
              },
            )
          }
        >
          Add
        </Button>
      </div>
      {brand && (
        <p className="text-xs text-zinc-500">
          A new reason starts at no shop: pick the shops that get it next.
        </p>
      )}
      <SyncMsg msg={shops.msg} />
      {error && <Notice tone="red">{error}</Notice>}
      {shops.dialog}
    </div>
  );
}

function ArchivedRow({ reason }: { reason: BlockReason }) {
  const { pending, error, run } = useAction();
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex items-center gap-3 text-sm">
        <span
          className="size-3 rounded-full"
          style={{ backgroundColor: reason.color }}
        />
        <span className="font-medium text-zinc-600">{reason.label}</span>
        <span className="text-xs text-zinc-500">
          {USE_LABEL[reason.usedFor]}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="ml-auto"
          disabled={pending}
          onClick={() => run(() => archiveReasonAction(reason.id, false))}
        >
          Restore
        </Button>
      </div>
      {error && <Notice tone="red">{error}</Notice>}
    </li>
  );
}
