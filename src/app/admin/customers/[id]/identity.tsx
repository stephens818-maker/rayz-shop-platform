"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ClientAvatar, ClientHitRow } from "@/components/client-hit";
import { Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import type { ClientHit } from "@/domain/client-search";
import { shrinkPhoto } from "@/lib/shrink-photo";
import { searchCustomersAction } from "../../calendar/actions";
import { setClientPhotoAction, updateClientIdentityAction } from "../actions";

/**
 * Who the client is at a glance: photo, client number and loyalty card, nickname, how they found
 * us and who referred them.
 */
export function ClientIdentity(p: {
  id: string;
  firstName: string;
  lastName: string | null;
  number: number;
  nickname: string | null;
  source: string | null;
  referredBy: { id: string; name: string } | null;
  referrals: number;
  sources: string[];
  photo: { has: boolean; shown: boolean; canAdd: boolean; canEdit: boolean };
  canEdit: boolean;
  card: { value: string; svg: string };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [showCard, setShowCard] = useState(false);
  const [nickname, setNickname] = useState(p.nickname ?? "");
  const [source, setSource] = useState(p.source ?? "");
  const [ref, setRef] = useState(p.referredBy);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<ClientHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!editing || q.trim().length < 2) return setFound([]);
    const t = setTimeout(async () => {
      const r = await searchCustomersAction(q);
      if (r.ok) setFound(r.data.filter((f) => f.id !== p.id));
    }, 250);
    return () => clearTimeout(t);
  }, [q, editing, p.id]);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) =>
    start(async () => {
      setError(null);
      const r = await fn();
      if (!r.ok) return setError(r.error ?? "Something went wrong");
      after?.();
      router.refresh();
    });
  const mayPhoto = p.photo.has ? p.photo.canEdit : p.photo.canAdd;

  return (
    <Card>
      <CardHeader
        title="Client"
        subtitle={`Client #${p.number}`}
        action={
          p.canEdit &&
          !editing && (
            <button className="text-xs underline" onClick={() => setEditing(true)}>
              Edit
            </button>
          )
        }
      />
      <div className="space-y-3 p-4 text-sm">
        <div className="flex items-center gap-3">
          <ClientAvatar hit={{ id: p.id, firstName: p.firstName, lastName: p.lastName, photo: p.photo.has && p.photo.shown }} size={64} />
          <div className="min-w-0 flex-1 space-y-1">
            {p.photo.has && !p.photo.shown && <div className="text-xs text-zinc-500">Photo on file</div>}
            {mayPhoto && (
              <div className="flex flex-wrap gap-2">
                <label className="cursor-pointer text-xs underline">
                  {p.photo.has ? "Replace photo" : "Add photo"}
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    capture="user"
                    className="sr-only"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = "";
                      if (file) {
                        const url = await shrinkPhoto(file);
                        run(() => setClientPhotoAction(p.id, url));
                      }
                    }}
                  />
                </label>
                {p.photo.has && p.photo.canEdit && (
                  <button className="text-xs text-red-700 underline" disabled={pending} onClick={() => confirm("Remove this client's photo?") && run(() => setClientPhotoAction(p.id, null))}>
                    Remove
                  </button>
                )}
              </div>
            )}
            <button className="text-xs underline" onClick={() => setShowCard(!showCard)}>
              {showCard ? "Hide loyalty card" : "Show loyalty card"}
            </button>
          </div>
        </div>
        {showCard && (
          <div className="flex flex-col items-center gap-1 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200" data-testid="loyalty-card">
            <div className="h-40 w-40" dangerouslySetInnerHTML={{ __html: p.card.svg }} />
            <div className="font-mono text-[11px] text-zinc-500">{p.card.value}</div>
            <div className="text-center text-xs text-zinc-500">Scan it into any client search, at any Ray&apos;z shop.</div>
          </div>
        )}
        {editing ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () => updateClientIdentityAction(p.id, { nickname, source, referredById: ref?.id ?? null }),
                () => setEditing(false),
              );
            }}
          >
            <Field label="Nickname (search finds it)">
              <Input value={nickname} maxLength={40} onChange={(e) => setNickname(e.target.value)} />
            </Field>
            <Field label="Found us through">
              <Select value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Not recorded</option>
                {[...new Set([...p.sources, ...(p.source ? [p.source] : [])])].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Referred by">
              {ref ? (
                <div className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200">
                  <span>{ref.name}</span>
                  <button type="button" className="text-xs underline" onClick={() => setRef(null)}>
                    Change
                  </button>
                </div>
              ) : (
                <>
                  <Input placeholder="Search the client who sent them" value={q} onChange={(e) => setQ(e.target.value)} />
                  {found.length > 0 && (
                    <div className="mt-1 divide-y divide-zinc-100 rounded-lg ring-1 ring-zinc-200">
                      {found.map((f) => (
                        <button type="button" key={f.id} onClick={() => (setRef({ id: f.id, name: f.short }), setQ(""))} className="block w-full px-3 py-2 text-left hover:bg-zinc-50">
                          <ClientHitRow hit={f} />
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={pending}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <dl className="grid grid-cols-3 gap-y-1.5">
            <dt className="text-zinc-500">Nickname</dt>
            <dd className="col-span-2">{p.nickname ?? "—"}</dd>
            <dt className="text-zinc-500">Source</dt>
            <dd className="col-span-2">{p.source ?? "—"}</dd>
            <dt className="text-zinc-500">Referred by</dt>
            <dd className="col-span-2">
              {p.referredBy ? (
                <Link className="underline" href={`/admin/customers/${p.referredBy.id}`}>
                  {p.referredBy.name}
                </Link>
              ) : (
                "—"
              )}
            </dd>
            {p.referrals > 0 && (
              <>
                <dt className="text-zinc-500">Referred</dt>
                <dd className="col-span-2">
                  {p.referrals} client{p.referrals === 1 ? "" : "s"}
                </dd>
              </>
            )}
          </dl>
        )}
        {error && <Notice tone="red">{error}</Notice>}
      </div>
    </Card>
  );
}
