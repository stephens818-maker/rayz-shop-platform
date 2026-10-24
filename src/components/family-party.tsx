"use client";

import { useState } from "react";
import { togglePartyMember, type FamilyTiming, type PartyMember } from "@/domain/family";
import { Button, Field, Input, Select, cx } from "@/components/ui";

export type { PartyMember };
type Person = {
  id: string;
  firstName: string;
  age?: number | null;
  preferredStaffId?: string | null;
};
type Svc = { id: string; name: string; durationMin: number };
type Barber = { id: string; displayName: string };

const label = (p: Person) =>
  p.age != null ? `${p.firstName} (${p.age})` : p.firstName;

/** "You, Max, Ava" for the summary. */
export function partySummary(
  me: Person,
  kids: Person[],
  firstWho: string,
  party: PartyMember[],
) {
  const name = (id: string) =>
    id === me.id
      ? "You"
      : (kids.find((k) => k.id === id)?.firstName ?? "Someone");
  return [firstWho, ...party.map((m) => m.customerId)].map(name).join(", ");
}

/**
 * Who the appointment is for: the parent, one child or several. The first one picked takes the
 * time and service chosen above; everyone else picked comes too, each with their own service, at
 * the same time with another barber or right after.
 */
export function FamilyParty({
  me,
  kids,
  services,
  barbers,
  firstServiceId,
  firstWho,
  onFirstWho,
  party,
  onParty,
  meLabel,
  note = "Everyone is booked together or not at all. Reminders and receipts come to you.",
  hideTiming,
  children,
}: {
  meLabel?: string;
  /** The slot finder below picks everyone's times, so each person only picks a service and barber. */
  hideTiming?: boolean;
  note?: string;
  /** Under the chips: "Add a child". */
  children?: React.ReactNode;
  me: Person;
  kids: Person[];
  services: Svc[];
  barbers: Barber[];
  firstServiceId: string | null;
  firstWho: string;
  onFirstWho: (id: string) => void;
  party: PartyMember[];
  onParty: (p: PartyMember[]) => void;
}) {
  const everyone: Person[] = [
    { ...me, firstName: meLabel ?? `Me (${me.firstName})` },
    ...kids,
  ];
  const byId = new Map(everyone.map((p) => [p.id, p]));
  const set = (id: string, patch: Partial<PartyMember>) =>
    onParty(party.map((m) => (m.customerId === id ? { ...m, ...patch } : m)));
  const toggle = (p: Person) => {
    const next = togglePartyMember({ firstWho, party }, p.id, {
      serviceId: firstServiceId ?? services[0]?.id ?? "",
      staffId: p.preferredStaffId ?? null,
    });
    if (next.firstWho !== firstWho) onFirstWho(next.firstWho);
    onParty(next.party);
  };
  const picked = (id: string) =>
    id === firstWho || party.some((m) => m.customerId === id);
  const first = byId.get(firstWho);
  return (
    <div className="mb-4 space-y-3" data-testid="family-party">
      <div>
        <div className="mb-1.5 text-sm font-medium text-zinc-700">
          Who is this appointment for?{" "}
          {everyone.length > 1 && (
            <span className="font-normal text-zinc-500">
              Pick one or more.
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {everyone.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={picked(p.id)}
              data-testid="family-chip"
              onClick={() => toggle(p)}
              className={cx(
                "rounded-full px-3 py-1.5 text-sm ring-1 transition",
                picked(p.id)
                  ? "bg-ink-900 text-white ring-ink-900"
                  : "bg-white ring-zinc-300 hover:ring-zinc-500",
              )}
            >
              {picked(p.id) && <span aria-hidden>✓ </span>}
              {label(p)}
            </button>
          ))}
        </div>
        {children}
      </div>
      {party.length > 0 && (
        <div className="space-y-2">
          {first && (
            <p className="text-xs text-zinc-500">
              {hideTiming
                ? `${label(first)} has the service and barber picked above.`
                : `${label(first)} takes the time and service picked above.`}
            </p>
          )}
          {party.map((m) => {
            const p = byId.get(m.customerId);
            if (!p) return null;
            return (
              <div
                key={m.customerId}
                className="rounded-lg bg-brand-50 px-3 py-2 ring-1 ring-brand-600"
                data-testid="party-member"
              >
                <div className="text-sm font-medium">{label(p)}</div>
                <div
                  className={cx(
                    "mt-2 grid gap-2",
                    hideTiming ? "sm:grid-cols-2" : "sm:grid-cols-3",
                  )}
                >
                  <Field label="Service">
                    <Select
                      value={m.serviceId}
                      onChange={(e) =>
                        set(p.id, { serviceId: e.target.value })
                      }
                    >
                      {services.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.durationMin} min
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {!hideTiming && (
                    <Field label="When">
                      <Select
                        value={m.timing}
                        onChange={(e) =>
                          set(p.id, {
                            timing: e.target.value as FamilyTiming,
                          })
                        }
                      >
                        <option value="same_time">
                          Same time, another barber
                        </option>
                        <option value="after">Right after</option>
                      </Select>
                    </Field>
                  )}
                  <Field label="Barber">
                    <Select
                      value={m.staffId ?? ""}
                      onChange={(e) =>
                        set(p.id, { staffId: e.target.value || null })
                      }
                    >
                      <option value="">
                        {hideTiming
                          ? "Any barber"
                          : m.timing === "after"
                            ? "Same barber if free, else any"
                            : "Any free barber"}
                      </option>
                      {barbers.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.displayName}
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
              </div>
            );
          })}
          <p className="text-xs text-zinc-500">{note}</p>
        </div>
      )}
    </div>
  );
}

/** The desk adding a child on the spot: first name and age; the rest can wait for the profile. */
export function AddChildInline({
  onAdd,
  disabled,
}: {
  onAdd: (input: {
    firstName: string;
    age: number | null;
  }) => Promise<string | null>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [first, setFirst] = useState("");
  const [age, setAge] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="mt-1.5 text-xs font-medium text-brand-700 underline"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        + Add a child
      </button>
    );
  return (
    <div
      className="mt-2 flex flex-wrap items-end gap-2"
      data-testid="add-child-inline"
    >
      <Field label="Child's first name">
        <Input
          value={first}
          onChange={(e) => setFirst(e.target.value)}
          className="w-36"
        />
      </Field>
      <Field label="Age">
        <Input
          value={age}
          onChange={(e) =>
            setAge(e.target.value.replace(/\D/g, "").slice(0, 2))
          }
          inputMode="numeric"
          className="w-16"
        />
      </Field>
      <Button
        size="sm"
        disabled={busy || !first.trim()}
        onClick={async () => {
          setBusy(true);
          const e = await onAdd({
            firstName: first.trim(),
            age: age ? Number(age) : null,
          });
          setBusy(false);
          setErr(e);
          if (!e) {
            setFirst("");
            setAge("");
            setOpen(false);
          }
        }}
      >
        Add
      </Button>
      <button
        type="button"
        className="text-xs text-zinc-500 underline"
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
      {err && <p className="w-full text-xs text-red-700">{err}</p>}
    </div>
  );
}
