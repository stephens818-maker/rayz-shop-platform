"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Badge, Button, Field, Input, Notice, Select } from "@/components/ui";
import { STOP_LINE, type Channel, type Templates } from "@/domain/marketing";
import { saveTemplateAction, setTemplateStatusAction } from "../actions";
import { ChannelPreview } from "../channel-preview";
import { ChannelOrder, TemplateFields } from "../template-fields";

export interface TemplateRow {
  id: string;
  name: string;
  campaignType: "update" | "promotion";
  description: string | null;
  channels: Channel[];
  templates: Templates;
  status: "draft" | "approved" | "archived";
}

const BLANK: TemplateRow = {
  id: "",
  name: "",
  campaignType: "update",
  description: null,
  channels: ["sms", "email", "push"],
  templates: { sms: `{shop}: Hi {first_name}, . Book: {book_link} ${STOP_LINE}`, emailSubject: "News from {shop}", emailBody: "Hi {first_name},\n\n\n\nBook: {book_link}", pushTitle: "{shop}", pushBody: "" },
  status: "draft",
};

export function TemplateEditor({ initial, address, onDone }: { initial: TemplateRow | null; address: string; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [t, setT] = useState<TemplateRow>(initial ?? BLANK);
  const set = (x: Partial<TemplateRow>) => setT({ ...t, ...x });
  return (
    <div className="space-y-4 p-4" data-testid="template-editor">
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Name">
          <Input value={t.name} onChange={(e) => set({ name: e.target.value })} placeholder="New hours" />
        </Field>
        <Field label="Type">
          <Select value={t.campaignType} onChange={(e) => set({ campaignType: e.target.value as TemplateRow["campaignType"] })}>
            <option value="update">Quick update</option>
            <option value="promotion">Promotion (uses a coupon)</option>
          </Select>
        </Field>
        <Field label="When to use it">
          <Input value={t.description ?? ""} onChange={(e) => set({ description: e.target.value || null })} />
        </Field>
      </div>
      <Field label="Channels">
        <ChannelOrder value={t.channels} onChange={(channels) => set({ channels })} />
      </Field>
      <TemplateFields value={t.templates} channels={t.channels} address={address} onChange={(templates) => set({ templates })} />
      <ChannelPreview templates={t.templates} channels={t.channels} address={address} />
      {initial?.status === "approved" && <Notice tone="amber">Changing the wording sends it back to draft until it&apos;s approved again.</Notice>}
      {error && <Notice tone="red">{error}</Notice>}
      <div className="flex gap-2">
        <Button
          disabled={pending || !t.name.trim()}
          onClick={() =>
            start(async () => {
              const r = await saveTemplateAction({ id: t.id || null, name: t.name, campaignType: t.campaignType, description: t.description, channels: t.channels, templates: t.templates });
              if (!r.ok) return setError(r.error);
              setError(null);
              onDone?.();
              router.refresh();
            })
          }
        >
          Save template
        </Button>
        {onDone && (
          <Button variant="ghost" onClick={onDone}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

export function TemplateRowActions({ row, address }: { row: TemplateRow; address: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = (s: TemplateRow["status"]) =>
    start(async () => {
      const r = await setTemplateStatusAction(row.id, s);
      setError(r.ok ? null : r.error);
      router.refresh();
    });
  return (
    <>
      <span className="flex flex-wrap justify-end gap-3 text-xs">
        <button className="underline" onClick={() => setEditing(!editing)}>
          {editing ? "Close" : "Edit"}
        </button>
        {row.status !== "approved" && row.status !== "archived" && (
          <button className="underline" disabled={pending} onClick={() => status("approved")} data-testid="approve-template">
            Approve
          </button>
        )}
        {row.status === "approved" && (
          <button className="underline" disabled={pending} onClick={() => status("draft")}>
            Back to draft
          </button>
        )}
        {row.status !== "archived" ? (
          <button className="text-red-700 underline" disabled={pending} onClick={() => status("archived")}>
            Archive
          </button>
        ) : (
          <button className="underline" disabled={pending} onClick={() => status("draft")}>
            Restore
          </button>
        )}
        {error && <Badge tone="red">{error}</Badge>}
      </span>
      {editing && (
        <div className="mt-2 rounded-lg text-left ring-1 ring-zinc-200">
          <TemplateEditor initial={row} address={address} onDone={() => setEditing(false)} />
        </div>
      )}
    </>
  );
}

export function NewTemplate({ address }: { address: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <TemplateEditor initial={null} address={address} onDone={() => setOpen(false)} />
  ) : (
    <div className="p-4">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        New template
      </Button>
    </div>
  );
}
