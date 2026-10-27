"use client";

import { useState } from "react";
import { Button, Input, Select } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { PUNCH_LABEL, isRepeatedWallTime, type PunchType } from "@/domain/time-clock";
import { clearPinAction } from "../clock/actions";
import { addPunchAction, approveManagerAction, approveOwnAction, editPunchAction, lockPeriodAction, unlockPeriodAction, voidPunchAction } from "./actions";
import { DateTimeInput } from "@/components/time-input";
import { hhmmLabel } from "@/lib/time";

type Shop = { id: string; name: string };
type When = { local: string; later: boolean };

const TYPES = Object.keys(PUNCH_LABEL) as PunchType[];

function Err({ error }: { error: string | null }) {
  return error ? <span className="text-xs text-red-700">{error}</span> : null;
}

function WhenInput({ value, onChange }: { value: When; onChange: (w: When) => void }) {
  const repeated = value.local.length === 16 && isRepeatedWallTime(value.local);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <DateTimeInput value={value.local} onChange={(local) => onChange({ ...value, local })} required />
      {repeated && (
        <label className="inline-flex items-center gap-1 text-xs text-zinc-600">
          <input type="checkbox" checked={value.later} onChange={(e) => onChange({ ...value, later: e.target.checked })} />
          The second {hhmmLabel(value.local.slice(11))} (after clocks fell back)
        </label>
      )}
    </span>
  );
}

export function EditPunch({ punch, shops }: { punch: { id: string; type: PunchType; shopId: string; when: When }; shops: Shop[] }) {
  const { pending, error, run } = useAction();
  const [open, setOpen] = useState<"edit" | "void" | null>(null);
  const [type, setType] = useState(punch.type);
  const [shopId, setShopId] = useState(punch.shopId);
  const [when, setWhen] = useState(punch.when);
  const [reason, setReason] = useState("");
  if (!open)
    return (
      <span className="flex gap-2 text-xs">
        <button type="button" className="underline" onClick={() => setOpen("edit")}>
          Edit
        </button>
        <button type="button" className="text-red-700 underline" onClick={() => setOpen("void")}>
          Void
        </button>
      </span>
    );
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => (open === "edit" ? editPunchAction({ punchId: punch.id, when, type, shopId, reason }) : voidPunchAction({ punchId: punch.id, reason })),
          () => setOpen(null),
        );
      }}
    >
      {open === "edit" && (
        <>
          <Select value={type} onChange={(e) => setType(e.target.value as PunchType)} aria-label="Punch" className="w-36">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {PUNCH_LABEL[t]}
              </option>
            ))}
          </Select>
          <WhenInput value={when} onChange={setWhen} />
          {shops.length > 1 && (
            <Select value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop" className="w-40">
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </>
      )}
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={open === "edit" ? "Why (required, goes in the edit log)" : "Why void it (required)"} className="w-64" maxLength={300} aria-label="Reason" />
      <Button size="sm" variant={open === "void" ? "danger" : "primary"} disabled={pending || !reason.trim()}>
        {open === "edit" ? "Save" : "Void punch"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(null)}>
        Cancel
      </Button>
      <Err error={error} />
    </form>
  );
}

export function AddPunch({ staffId, shops, defaultLocal }: { staffId: string; shops: Shop[]; defaultLocal: string }) {
  const { pending, error, run } = useAction();
  const [type, setType] = useState<PunchType>("out");
  const [shopId, setShopId] = useState(shops[0]?.id ?? "");
  const [when, setWhen] = useState<When>({ local: defaultLocal, later: false });
  const [reason, setReason] = useState("");
  return (
    <form
      className="flex flex-wrap items-center gap-2 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => addPunchAction({ staffId, shopId, type, when, reason }),
          () => setReason(""),
        );
      }}
    >
      <Select value={type} onChange={(e) => setType(e.target.value as PunchType)} aria-label="Punch" className="w-36">
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {PUNCH_LABEL[t]}
          </option>
        ))}
      </Select>
      <WhenInput value={when} onChange={setWhen} />
      {shops.length > 1 && (
        <Select value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop" className="w-40">
          {shops.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      )}
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why (required, e.g. forgot to clock out)" className="w-64" maxLength={300} aria-label="Reason" />
      <Button size="sm" disabled={pending || !reason.trim() || !shopId || !when.local}>
        Add punch
      </Button>
      <Err error={error} />
    </form>
  );
}

export function ApproveOwn({ shopId, periodStart }: { shopId: string; periodStart: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" disabled={pending} onClick={() => run(() => approveOwnAction({ shopId, periodStart }))}>
        These hours are right: sign off
      </Button>
      <Err error={error} />
    </span>
  );
}

export function ManagerApprove({ staffId, shopId, periodStart, employeeApproved }: { staffId: string; shopId: string; periodStart: string; employeeApproved: boolean }) {
  const { pending, error, run } = useAction();
  const [note, setNote] = useState("");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!employeeApproved && <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="They haven't signed off: say why you're approving" className="w-72" maxLength={300} aria-label="Note" />}
      <Button size="sm" disabled={pending || (!employeeApproved && !note.trim())} onClick={() => run(() => approveManagerAction({ staffId, shopId, periodStart, note: note || null }))}>
        Approve as manager
      </Button>
      <Err error={error} />
    </span>
  );
}

export function ClearPin({ staffId, shopId }: { staffId: string; shopId: string }) {
  const { pending, error, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => confirm("Clear their front-desk PIN? They set a new one on their Time clock page.") && run(() => clearPinAction(staffId, shopId))}>
        Clear PIN
      </Button>
      <Err error={error} />
    </span>
  );
}

export function LockPeriod({ shopId, periodStart, locked, canUnlock }: { shopId: string; periodStart: string; locked: boolean; canUnlock: boolean }) {
  const { pending, error, run } = useAction();
  const [reason, setReason] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  if (!locked)
    return (
      <span className="inline-flex items-center gap-2">
        <Button size="sm" variant="dark" disabled={pending} onClick={() => run(() => lockPeriodAction({ shopId, periodStart }))}>
          Lock period
        </Button>
        <Err error={error} />
      </span>
    );
  if (!canUnlock) return null;
  if (!unlocking)
    return (
      <button type="button" className="text-xs underline" onClick={() => setUnlocking(true)}>
        Unlock
      </button>
    );
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why reopen it (required)" className="w-56" maxLength={300} aria-label="Reason" />
      <Button size="sm" variant="danger" disabled={pending || !reason.trim()} onClick={() => run(() => unlockPeriodAction({ shopId, periodStart, reason }), () => setUnlocking(false))}>
        Unlock
      </Button>
      <Err error={error} />
    </span>
  );
}
