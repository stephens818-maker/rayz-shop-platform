"use client";

import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Card, CardHeader, Field, Input, Notice, Select } from "@/components/ui";
import { simulateCallAction, simulateOutreachCallAction, simulateTextAction } from "./actions";

/** Twilio's reply, shown so the tester can see what the caller would hear. */
function Spoken({ twiml }: { twiml: string[] }) {
  const said = twiml.flatMap((x) => [...x.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1].replace(/&apos;/g, "'").replace(/&amp;/g, "&")));
  const dialed = twiml.some((x) => x.includes("<Dial"));
  if (!said.length && !dialed) return null;
  return (
    <div className="mt-2 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-700">
      {said.map((s, i) => (
        <p key={i}>
          <span className="font-medium">Says:</span> {s}
        </p>
      ))}
      {dialed && <p className="text-zinc-500">Rings the shop phone, showing the shop&apos;s number.</p>}
    </div>
  );
}

export function SimForm({ shops, threads }: { shops: { id: string; name: string; line: string | null }[]; threads: { id: string; shopId: string; label: string }[] }) {
  const { pending, error, run } = useAction();
  const [shopId, setShopId] = useState(shops.find((s) => s.line)?.id ?? shops[0]?.id ?? "");
  const [threadId, setThreadId] = useState("");
  const [phone, setPhone] = useState("");
  const [body, setBody] = useState("1");
  const [key, setKey] = useState("1");
  const [out, setOut] = useState<string | null>(null);
  const [twiml, setTwiml] = useState<string[]>([]);
  const from = { threadId: threadId || null, phone: threadId ? null : phone };
  const shop = shops.find((s) => s.id === shopId);
  const mine = threads.filter((t) => t.shopId === shopId);
  return (
    <Card>
      <CardHeader title="Be the client" subtitle="Text or call a shop's number as one of the conversations in the inbox, or as any number." />
      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <Field label="Shop number" hint={shop?.line ? shop.line : "No Twilio number yet: add one in Shop settings"}>
          <Select value={shopId} onChange={(e) => (setShopId(e.target.value), setThreadId(""))}>
            {shops.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Select value={threadId} onChange={(e) => setThreadId(e.target.value)}>
            <option value="">A number I type</option>
            {mine.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </Select>
        </Field>
        {!threadId && (
          <Field label="Phone number">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(319) 555-0199" inputMode="tel" />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap items-end gap-3 border-t border-zinc-100 px-4 py-3">
        <Field label="Text" className="min-w-60 flex-1">
          <Input value={body} onChange={(e) => setBody(e.target.value)} placeholder="1, 2, STOP, or anything" />
        </Field>
        <Button disabled={pending || !shop?.line} onClick={() => run(() => simulateTextAction(shopId, from, body), (d) => (setTwiml([]), setOut(`Text received: ${d.handled.replace("_", " ")}`)))}>
          Send text
        </Button>
        <Field label="If the phone operator answers, press">
          <Select value={key} onChange={(e) => setKey(e.target.value)}>
            <option value="1">1: text me a booking link</option>
            <option value="2">2: hear the hours</option>
            <option value="3">3: talk to the shop</option>
            <option value="">Nothing</option>
          </Select>
        </Field>
        <Button variant="secondary" disabled={pending || !shop?.line} onClick={() => run(() => simulateCallAction(shopId, from, "answered", key), (d) => (setTwiml(d.twiml), setOut("Called the shop: answered")))}>
          Call: shop answers
        </Button>
        <Button variant="secondary" disabled={pending || !shop?.line} onClick={() => run(() => simulateCallAction(shopId, from, "missed", key), (d) => (setTwiml(d.twiml), setOut("Called the shop: nobody answered")))}>
          Call: nobody answers
        </Button>
      </div>
      <div className="px-4 pb-4">
        {error && <Notice tone="red">{error}</Notice>}
        {out && !error && <Notice tone="green">{out}</Notice>}
        <Spoken twiml={twiml} />
      </div>
    </Card>
  );
}

export function OutreachCallButtons({ jobId }: { jobId: string }) {
  const { pending, error, run } = useAction();
  const [twiml, setTwiml] = useState<string[]>([]);
  const go = (answer: "human" | "machine" | "no_answer", digits?: string) => run(() => simulateOutreachCallAction(jobId, answer, digits ?? null), (d) => setTwiml(d.twiml));
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => go("human", "1")}>
          Picks up, presses 1
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => go("human", "2")}>
          Presses 2
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => go("human", "9")}>
          Presses 9
        </Button>
        <Button size="sm" variant="secondary" disabled={pending} onClick={() => go("machine")}>
          Voicemail
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => go("no_answer")}>
          No answer
        </Button>
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <Spoken twiml={twiml} />
    </div>
  );
}
