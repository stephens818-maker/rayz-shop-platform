"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { PinIcon } from "@/components/pin-icon";
import { Badge, Button, Card, CardHeader, Field, Input, Select, Textarea, cx } from "@/components/ui";
import {
  type ClientNoteView,
  type CutDetails,
  NOTE_KIND_HINT,
  NOTE_KIND_LABEL,
  NOTE_MAX,
  NOTE_PHOTOS_MAX,
  type NoteKind,
  type NotePhotoKind,
  contactPatterns,
  contactWarning,
  detailsLine,
} from "@/domain/client-notes";
import { shrinkPhoto } from "@/lib/shrink-photo";
import type { ActionResult } from "@/server/action";
import { addNoteAction, addNotePhotoAction, editNoteAction, removeNoteAction, removeNotePhotoAction } from "../../notes/actions";

export interface NotesCardList {
  mode: "full" | "count" | null;
  count: number;
  notes: ClientNoteView[];
  canWrite: NoteKind[];
}

type Tab = "all" | NoteKind;
type Draft = { kind: NoteKind; body: string; pinned: boolean; guard: string; style: string; products: string; appointmentId: string };
const blank = (kind: NoteKind): Draft => ({ kind, body: "", pinned: kind === "profile", guard: "", style: "", products: "", appointmentId: "" });
const draftOf = (n: ClientNoteView): Draft => ({
  kind: n.kind,
  body: n.body,
  pinned: n.pinned,
  guard: n.details?.guard ?? "",
  style: n.details?.style ?? "",
  products: n.details?.products?.join(", ") ?? "",
  appointmentId: n.appointmentId ?? "",
});
const detailsOf = (d: Draft): CutDetails => ({
  guard: d.guard,
  style: d.style,
  products: d.products
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean),
});
const TONE: Record<NoteKind, "blue" | "green" | "amber"> = { profile: "blue", visit: "green", private: "amber" };
const removedText = (r: string[]) => (r.length ? `Saved. ${r.length === 2 ? "A phone number and an email address were" : r[0] === "phone" ? "A phone number was" : "An email address was"} taken out.` : null);

/**
 * A client's notes from every location: pinned profile notes, cut notes with before and after
 * photos, and private manager notes for people who see them. The record note is the profile's
 * notes field (and what Squire brought over).
 */
export function NotesCard({ customerId, firstName, list, visits }: { customerId: string; firstName: string; list: NotesCardList; visits: { id: string; label: string }[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blank(list.canWrite[0] ?? "profile"));

  if (!list.mode) return null;
  if (list.mode === "count") {
    return (
      <Card>
        <CardHeader title="Notes" />
        <p className="p-4 text-sm text-zinc-600">
          {list.count ? `${list.count} note${list.count === 1 ? "" : "s"} on file.` : "No notes yet."} Client notes are masked for you.
        </p>
      </Card>
    );
  }

  const run = <T,>(fn: () => Promise<ActionResult<T>>, after?: (data: T) => void) =>
    start(async () => {
      setError(null);
      setNotice(null);
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.(r.data);
      router.refresh();
    });
  const saved = (d: { removed: string[] }) => {
    setNotice(removedText(d.removed));
    setEditing(null);
  };
  const kinds = (["profile", "visit", "private"] as const).filter((k) => list.notes.some((n) => n.kind === k) || list.canWrite.includes(k));
  const shown = list.notes.filter((n) => tab === "all" || n.kind === tab);
  const warn = contactWarning(contactPatterns([draft.body, draft.guard, draft.style, draft.products].join("\n")));

  const addPhoto = (n: ClientNoteView, kind: NotePhotoKind, file: File | undefined) => {
    if (!file) return;
    run(async () => addNotePhotoAction(customerId, n.id, kind, await shrinkPhoto(file, 640)));
  };

  const form = (save: () => void, isNew: boolean) => (
    <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
      {isNew && list.canWrite.length > 1 && (
        <Field label="Kind" hint={NOTE_KIND_HINT[draft.kind]}>
          <Select value={draft.kind} onChange={(e) => setDraft({ ...blank(e.target.value as NoteKind), body: draft.body })}>
            {list.canWrite.map((k) => (
              <option key={k} value={k}>
                {NOTE_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {draft.kind === "visit" && (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Guard numbers">
            <Input value={draft.guard} placeholder="#1 sides, #3 top" maxLength={80} onChange={(e) => setDraft({ ...draft, guard: e.target.value })} />
          </Field>
          <Field label="Style">
            <Input value={draft.style} placeholder="Mid skin fade" maxLength={120} onChange={(e) => setDraft({ ...draft, style: e.target.value })} />
          </Field>
          <Field label="Products used" className="col-span-2" hint="Separate with commas">
            <Input value={draft.products} placeholder="Matte clay, sea salt spray" onChange={(e) => setDraft({ ...draft, products: e.target.value })} />
          </Field>
          {isNew && visits.length > 0 && (
            <Field label="Visit" className="col-span-2">
              <Select value={draft.appointmentId} onChange={(e) => setDraft({ ...draft, appointmentId: e.target.value })}>
                <option value="">Not tied to a visit</option>
                {visits.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
      )}
      <Field label={draft.kind === "visit" ? "Notes" : "Note"}>
        <Textarea rows={3} maxLength={NOTE_MAX} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-describedby="note-contact-warning" />
      </Field>
      {warn && (
        <p id="note-contact-warning" role="alert" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          {warn}
        </p>
      )}
      {draft.kind !== "visit" && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.pinned} onChange={(e) => setDraft({ ...draft, pinned: e.target.checked })} />
          Pin: show on {firstName}&apos;s appointments and at check-in
        </label>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={save}>
          {pending ? "Saving…" : "Save note"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader
        title="Notes"
        subtitle="Seen at every location this client visits."
        action={
          list.canWrite.length > 0 &&
          editing !== "new" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(blank(tab !== "all" && list.canWrite.includes(tab) ? tab : list.canWrite[0]));
                setEditing("new");
              }}
            >
              Add note
            </Button>
          )
        }
      />
      <div className="space-y-3 p-4">
        {kinds.length > 1 && (
          <div className="flex flex-wrap gap-1 text-xs" role="tablist">
            {(["all", ...kinds] as Tab[]).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={cx("rounded-full px-2.5 py-1", tab === t ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200")}
                onClick={() => setTab(t)}
              >
                {t === "all" ? `All (${list.notes.length})` : `${t === "visit" ? "Cut notes" : t === "private" ? "Private" : "Profile"} (${list.notes.filter((n) => n.kind === t).length})`}
              </button>
            ))}
          </div>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {notice && <p className="text-sm text-amber-700">{notice}</p>}
        {editing === "new" &&
          form(
            () =>
              run(
                () =>
                  addNoteAction(customerId, {
                    kind: draft.kind,
                    body: draft.body,
                    pinned: draft.pinned,
                    details: draft.kind === "visit" ? detailsOf(draft) : null,
                    appointmentId: draft.kind === "visit" && draft.appointmentId ? draft.appointmentId : null,
                  }),
                saved,
              ),
            true,
          )}
        {shown.length === 0 && editing !== "new" && <p className="text-sm text-zinc-500">No notes yet.</p>}
        <ul className="space-y-2">
          {shown.map((n) =>
            editing === n.id ? (
              <li key={n.id}>
                {form(
                  () =>
                    run(
                      () => editNoteAction(customerId, n.id, { body: draft.body, pinned: draft.pinned, ...(n.kind === "visit" ? { details: detailsOf(draft) } : {}) }),
                      saved,
                    ),
                  false,
                )}
              </li>
            ) : (
              <li key={n.id} className={cx("rounded-lg border p-3 text-sm", n.pinned ? "border-amber-300 bg-amber-50/50" : "border-zinc-200")}>
                <div className="mb-1 flex flex-wrap items-center gap-1.5">
                  {n.pinned && <PinIcon className="h-3.5 w-3.5 text-amber-600" title="Pinned" />}
                  <Badge tone={TONE[n.kind]}>{n.kind === "visit" ? "Cut note" : n.kind === "private" ? "Private" : "Profile"}</Badge>
                  {n.source === "record" && <span className="text-xs text-zinc-500">Client record</span>}
                </div>
                {n.details && <p className="font-medium text-zinc-800">{detailsLine(n.details)}</p>}
                {n.body && <p className="whitespace-pre-wrap text-zinc-800">{n.body}</p>}
                {n.photos.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {n.photos.map((p) => (
                      <figure key={p.id} className="relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={p.url} alt={`${p.kind === "before" ? "Before" : "After"} photo`} className="h-20 w-20 rounded object-cover" />
                        <figcaption className="text-center text-[11px] text-zinc-500">{p.kind === "before" ? "Before" : "After"}</figcaption>
                        {n.canEdit && (
                          <button
                            className="absolute right-0.5 top-0.5 rounded bg-white/90 px-1 text-[11px] text-red-700"
                            aria-label="Remove photo"
                            onClick={() => run(() => removeNotePhotoAction(customerId, p.id))}
                          >
                            ✕
                          </button>
                        )}
                      </figure>
                    ))}
                  </div>
                )}
                <p className="mt-1 text-xs text-zinc-500">
                  {n.credit}
                  {n.edited && ` · edited${n.editedBy ? ` by ${n.editedBy}` : ""}`}
                </p>
                {n.canEdit && (
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                    <button
                      className="underline"
                      onClick={() => {
                        setDraft(draftOf(n));
                        setEditing(n.id);
                      }}
                    >
                      Edit
                    </button>
                    {n.kind !== "visit" && (
                      <button className="underline" disabled={pending} onClick={() => run(() => editNoteAction(customerId, n.id, { pinned: !n.pinned }))}>
                        {n.pinned ? "Unpin" : "Pin"}
                      </button>
                    )}
                    {n.kind === "visit" &&
                      n.photos.length < NOTE_PHOTOS_MAX &&
                      (["before", "after"] as const).map((k) => (
                        <label key={k} className="cursor-pointer underline">
                          Add {k} photo
                          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => addPhoto(n, k, e.target.files?.[0])} />
                        </label>
                      ))}
                    <button
                      className="text-red-700 underline"
                      disabled={pending}
                      onClick={() => {
                        if (confirm(n.source === "record" ? "Remove this note? It also clears the notes field on the profile." : "Remove this note?")) run(() => removeNoteAction(customerId, n.id));
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            ),
          )}
        </ul>
      </div>
    </Card>
  );
}
