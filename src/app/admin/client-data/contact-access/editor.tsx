"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import { CONTACT_GRANT_HINT, CONTACT_GRANT_KINDS, CONTACT_GRANT_LABEL, type ContactGrantKind } from "@/domain/contact-grants";
import { giveContactGrantAction, revokeContactGrantAction } from "./actions";

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

export function GrantForm({
  people,
  shops,
  mayGive,
}: {
  people: { id: string; label: string }[];
  shops: { id: string; name: string }[];
  /** What the signed-in person may give: only what they hold themselves. */
  mayGive: Record<ContactGrantKind, boolean>;
}) {
  const { pending, error, run } = useRun();
  const [kind, setKind] = useState<ContactGrantKind>(CONTACT_GRANT_KINDS.find((k) => mayGive[k]) ?? "full_contact");
  const [to, setTo] = useState<"person" | "location">("person");
  const [target, setTarget] = useState("");
  const [until, setUntil] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState(false);
  const give = () =>
    run(
      () => giveContactGrantAction({ kind, staffId: to === "person" ? target : null, shopId: to === "location" ? target : null, until: until || null, note: note || null }),
      () => (setTarget(""), setUntil(""), setNote(""), setDone(true)),
    );
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-2">
      <Field label="What" hint={CONTACT_GRANT_HINT[kind]}>
        <Select aria-label="What" value={kind} onChange={(e) => (setDone(false), setKind(e.target.value as ContactGrantKind))}>
          {CONTACT_GRANT_KINDS.map((k) => (
            <option key={k} value={k} disabled={!mayGive[k]}>
              {CONTACT_GRANT_LABEL[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="To" hint={to === "location" ? "Everyone who works there, including its shop login, while they're working there." : "This person or shop login, at every location they work."}>
        <div className="flex gap-2">
          <Select aria-label="To" value={to} onChange={(e) => (setTarget(""), setTo(e.target.value as "person" | "location"))} className="w-36">
            <option value="person">A person</option>
            <option value="location">A location</option>
          </Select>
          <Select aria-label={to === "person" ? "Person" : "Location"} value={target} onChange={(e) => (setDone(false), setTarget(e.target.value))}>
            <option value="">{to === "person" ? "Person or shop login…" : "Location…"}</option>
            {(to === "person" ? people.map((p) => ({ id: p.id, name: p.label })) : shops).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
      </Field>
      <Field label="Until" hint="The last day it applies. Leave empty to keep it until it's revoked.">
        <Input type="date" aria-label="Until" value={until} onChange={(e) => setUntil(e.target.value)} />
      </Field>
      <Field label="Why (optional)" hint="Shown to the brand with the grant. Don't put client details here.">
        <Input aria-label="Why" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Running the Coralville reopening mailing" />
      </Field>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button disabled={pending || !target || !mayGive[kind]} onClick={give}>
          Give access
        </Button>
        {done && <span className="text-sm text-zinc-600">Given. It applies on their next page load.</span>}
        {error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}

export function RevokeGrant({ id }: { id: string }) {
  const { pending, error, run } = useRun();
  return (
    <>
      <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => revokeContactGrantAction(id))}>
        Revoke
      </Button>
      {error && <span className="ml-2 text-xs text-red-600">{error}</span>}
    </>
  );
}
