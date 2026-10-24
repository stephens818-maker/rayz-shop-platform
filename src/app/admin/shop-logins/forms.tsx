"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Field, Input, Notice, Select } from "@/components/ui";
import { createShopLoginAction, resetShopLoginPasswordAction, setShopLoginActiveAction } from "./actions";

function OneTimePassword({ who, password }: { who: string; password: string }) {
  return (
    <Notice tone="green">
      Password for {who}: <span className="select-all font-mono font-semibold">{password}</span>. It&apos;s shown only now, so write it down or save it in the browser at that shop.
    </Notice>
  );
}

export function NewShopLoginForm({
  shop,
  roles,
  first,
}: {
  shop: { id: string; name: string; slug: string };
  roles: { id: string; name: string; key: string | null }[];
  first: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(first);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ who: string; password: string } | null>(null);
  const desk = roles.find((r) => r.key === "shop_login") ?? roles.find((r) => r.key === "front_desk") ?? roles[0];
  const [v, setV] = useState({ label: `${shop.name} desk`.slice(0, 24), email: `${shop.slug}.desk@`, roleId: desk?.id ?? "" });

  if (!roles.length) return <div className="border-t border-zinc-100 px-4 py-3 text-sm text-zinc-500">You can&apos;t give any role to a shop login.</div>;
  return (
    <div className="border-t border-zinc-100 p-4">
      {made && <OneTimePassword who={made.who} password={made.password} />}
      {!open ? (
        <button className="text-sm underline" onClick={() => setOpen(true)}>
          Add a login for {shop.name}
        </button>
      ) : (
        <div className="mt-2 space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Name" hint="Shown in the sidebar and the audit log.">
              <Input value={v.label} maxLength={24} onChange={(e) => setV({ ...v, label: e.target.value })} />
            </Field>
            <Field label="Sign-in email">
              <Input type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
            </Field>
            <Field label="Role">
              <Select value={v.roleId} onChange={(e) => setV({ ...v, roleId: e.target.value })}>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {error && <Notice tone="red">{error}</Notice>}
          <div className="flex items-center gap-3">
            <Button
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const r = await createShopLoginAction({ shopId: shop.id, ...v });
                  if (!r.ok) return setError(r.error);
                  setMade({ who: v.label, password: r.data.password });
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              Create login
            </Button>
            <span className="text-xs text-zinc-500">A password is generated and shown once. The login can open only {shop.name}.</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function LoginActions({ id, label, active }: { id: string; label: string; active: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex gap-3 text-xs">
        <button
          className="underline disabled:opacity-40"
          disabled={pending}
          onClick={() =>
            start(async () => {
              if (!confirm(`Reset the password for ${label}? Anyone signed in with it is signed out.`)) return;
              const r = await resetShopLoginPasswordAction(id);
              if (!r.ok) return setError(r.error);
              setPassword(r.data.password);
              router.refresh();
            })
          }
        >
          Reset password
        </button>
        <button
          className="underline disabled:opacity-40"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await setShopLoginActiveAction(id, !active);
              if (!r.ok) return setError(r.error);
              router.refresh();
            })
          }
        >
          {active ? "Disable" : "Enable"}
        </button>
      </div>
      {error && <span className="text-xs text-red-600">{error}</span>}
      {password && (
        <span className="text-left text-xs">
          <OneTimePassword who={label} password={password} />
        </span>
      )}
    </div>
  );
}
