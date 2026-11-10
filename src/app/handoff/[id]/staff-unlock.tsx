"use client";

import { useEffect, useState, useTransition } from "react";
import { cx } from "@/components/ui";
import { unlockAction, unlockPeopleAction } from "./actions";
import { Keypad } from "./keypad";

type Person = { id: string; label: string };

/** Staff take the device back with their time clock PIN; the shop decides whether any staff PIN or only a manager's. */
export function StaffUnlock({ id, onClose }: { id: string; onClose: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [rule, setRule] = useState<"staff" | "manager">("staff");
  const [who, setWho] = useState<Person | null>(null);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    unlockPeopleAction(id).then((r) => {
      if (!r.ok) return setError(r.error);
      setRule(r.data.rule);
      setPeople(r.data.people);
      if (r.data.people.length === 1) setWho(r.data.people[0]);
    });
  }, [id]);

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await unlockAction(id, who!.id, pin);
      setPin("");
      if (!r.ok) return setError(r.error);
      window.location.replace(r.data.path);
    });

  return (
    <div role="dialog" aria-modal="true" aria-label="Staff unlock" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3">
      <div className="max-h-full w-full max-w-md overflow-y-auto rounded-3xl bg-ink-900 p-5 text-white shadow-2xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">{rule === "manager" ? "Manager PIN" : "Staff PIN"}</h2>
            <p className="text-sm text-zinc-400">{who ? `${who.label}, enter your time clock PIN` : "Who's taking the device back?"}</p>
          </div>
          <button type="button" onClick={onClose} className="min-h-12 rounded-xl px-4 text-base font-medium text-zinc-300 ring-1 ring-white/20">
            Cancel
          </button>
        </div>
        {error && (
          <div role="alert" className="mb-3 rounded-xl bg-red-500/15 px-4 py-3 text-sm text-red-200">
            {error}
          </div>
        )}
        {people == null ? (
          !error && <p className="py-6 text-center text-zinc-400">Loading…</p>
        ) : !people.length ? (
          <p className="py-4 text-sm text-zinc-300">
            {rule === "manager" ? "No manager here has a time clock PIN yet." : "No one here has a time clock PIN yet."} They set one on their Time clock page. Until then, end the hand-off from checkout on
            another device.
          </p>
        ) : !who ? (
          <div className="grid grid-cols-2 gap-2">
            {people.map((p) => (
              <button key={p.id} type="button" onClick={() => setWho(p)} className="min-h-14 truncate rounded-2xl bg-white/10 px-3 text-base font-medium active:bg-white/20">
                {p.label}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex justify-center gap-3" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: 6 }, (_, i) => (
                <span key={i} className={cx("h-4 w-4 rounded-full", i < pin.length ? "bg-white" : "bg-white/20")} />
              ))}
            </div>
            <Keypad value={pin} onChange={setPin} max={6} dark />
            <div className="grid grid-cols-2 gap-2">
              {people.length > 1 ? (
                <button type="button" onClick={() => (setWho(null), setPin(""))} className="min-h-14 rounded-2xl text-base font-medium ring-1 ring-white/20">
                  Someone else
                </button>
              ) : (
                <span />
              )}
              <button type="button" disabled={pin.length < 4 || pending} onClick={submit} className="min-h-14 rounded-2xl bg-white text-lg font-semibold text-ink-900 disabled:opacity-40">
                {pending ? "Checking…" : "Unlock"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
