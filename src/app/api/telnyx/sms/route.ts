import { createPublicKey, verify } from "node:crypto";
import { handleInboundSms } from "@/server/shop-line";

/** Telnyx "message.received". Verifies the signature when TELNYX_PUBLIC_KEY is set. Does not send. */
function signatureOk(raw: string, headers: Headers): boolean {
  const key = process.env.TELNYX_PUBLIC_KEY?.trim();
  if (!key) return process.env.NODE_ENV !== "production";
  const sig = headers.get("telnyx-signature-ed25519");
  const ts = headers.get("telnyx-timestamp");
  if (!sig || !ts) return false;
  try {
    const rawKey = Buffer.from(key, "base64");
    const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rawKey]);
    const pub = createPublicKey({ key: spki, format: "der", type: "spki" });
    return verify(null, Buffer.from(`${ts}|${raw}`), pub, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!signatureOk(raw, req.headers)) return new Response("invalid signature", { status: 401 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const data = body && typeof body === "object" && "data" in body ? (body as { data?: { event_type?: string; payload?: Record<string, unknown> } }).data : undefined;
  if (data?.event_type !== "message.received") return Response.json({ ok: true, ignored: true });
  const payload = data.payload ?? {};
  const fromObj = payload.from;
  const toList = payload.to;
  const from = fromObj && typeof fromObj === "object" && "phone_number" in fromObj ? String((fromObj as { phone_number: unknown }).phone_number) : "";
  const to = Array.isArray(toList) && toList[0] && typeof toList[0] === "object" && "phone_number" in toList[0] ? String((toList[0] as { phone_number: unknown }).phone_number) : "";
  const text = typeof payload.text === "string" ? payload.text : "";
  const id = typeof payload.id === "string" ? payload.id : null;
  await handleInboundSms({ from, to, body: text, messageSid: id, optOutType: /^\s*stop\s*$/i.test(text) ? "STOP" : null });
  return Response.json({ ok: true });
}
