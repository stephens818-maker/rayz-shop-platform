import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { formatPhone } from "@/lib/phone";
import { supportContact } from "@/server/app-config";
import { publicShops } from "@/server/public";

export const metadata: Metadata = { title: "Support" };
export const dynamic = "force-dynamic";

const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "I didn't get my sign-in code",
    a: "Codes can take a minute. Check the number, then ask for a new one (up to 5 an hour). If texts don't arrive, sign in with your email instead, if you've confirmed one.",
  },
  {
    q: "It says it can't sign me in, or asks to check my email",
    a: (
      <>
        Phone numbers get passed on to new people, so when a number hasn&apos;t been used here for a long time we double-check it&apos;s still you. Use the email code, or choose &ldquo;I can&apos;t
        sign in&rdquo; on <Link href="/account">your account</Link> and the shop will confirm it&apos;s you.
      </>
    ),
  },
  { q: "How do I cancel or move an appointment?", a: "Open the link in your confirmation text or email, or your account in the app, up to the shop's cutoff. After that, call the shop." },
  { q: "How do rewards work?", a: "The rules are on your account in the app and on the website. If something looks wrong after a visit, ask at the shop; they can see each visit." },
  {
    q: "How do I stop texts or emails?",
    a: "Reply STOP to any text (START to turn them back on), use the unsubscribe link in any email, or turn notifications off in your phone's settings.",
  },
  {
    q: "How do I delete my account?",
    a: (
      <>
        In the app under your account, or on the web at <Link href="/account/delete">Delete your account</Link>. It works even if you no longer have the app.
      </>
    ),
  },
];

export default async function SupportPage() {
  const support = supportContact();
  const shops = (await publicShops()).filter((s) => s.phone);
  return (
    <LegalPage title="Support">
      <p>The quickest help is your shop: they can see your bookings, rewards and gift cards.</p>
      {(support.email || support.phone) && (
        <p>
          For anything else, including privacy requests:{" "}
          {support.email && (
            <a href={`mailto:${support.email}`} data-testid="support-email">
              {support.email}
            </a>
          )}
          {support.email && support.phone && " · "}
          {support.phone && <a href={`tel:${support.phone}`}>{formatPhone(support.phone)}</a>}
        </p>
      )}
      <h2>Shops</h2>
      <ul>
        {shops.map((s) => (
          <li key={s.id}>
            <Link href={`/locations/${s.slug}`}>{s.name}</Link>, {s.city}, {s.state}: <a href={`tel:${s.phone}`}>{formatPhone(s.phone!)}</a>
          </li>
        ))}
      </ul>
      <h2>Common questions</h2>
      {FAQ.map((f) => (
        <div key={f.q}>
          <h3 className="font-semibold text-zinc-900">{f.q}</h3>
          <p className="mt-1">{f.a}</p>
        </div>
      ))}
      <h2>Policies</h2>
      <p>
        <Link href="/privacy">Privacy policy</Link> · <Link href="/terms">Terms of service</Link> · <Link href="/terms#sms">SMS terms</Link>
      </p>
    </LegalPage>
  );
}
