import type { Metadata } from "next";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appointmentItems, customers, shops, staff } from "@/db/schema";
import { LINK_STATE_MESSAGE } from "@/domain/outreach";
import { shopBarbers } from "@/server/catalog";
import { resolveLink } from "@/server/rebook-links";
import { Rebook } from "./rebook";

export const metadata: Metadata = { title: "Pick a new time", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * The one-tap link from a call-in text or email. The token is the only credential: it works for one
 * appointment, until it expires, is replaced by a newer link, or is used.
 */
export default async function RebookPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await resolveLink(token);
  if (r.state === "unknown")
    return (
      <Message title="This link doesn't work">
        Check that you opened the whole link from the text or email, or call the shop and we&apos;ll find you a time.
      </Message>
    );
  const a = r.appointment;
  const [shop, absent, barberNow, customer, items] = await Promise.all([
    db.query.shops.findFirst({ where: eq(shops.id, a.shopId) }),
    db.query.staff.findFirst({ where: eq(staff.id, r.outreach.originalStaffId), columns: { displayLabel: true } }),
    db.query.staff.findFirst({ where: eq(staff.id, a.staffId), columns: { displayLabel: true } }),
    a.customerId ? db.query.customers.findFirst({ where: eq(customers.id, a.customerId), columns: { firstName: true } }) : null,
    db.select().from(appointmentItems).where(eq(appointmentItems.appointmentId, a.id)),
  ]);
  const phone = shop?.twilioNumber ?? shop?.phone ?? null;
  if (r.state !== "ok")
    return (
      <Message title={r.state === "used" ? "You're all set" : "This link has stopped working"} code={r.state === "used" ? a.code : null} phone={phone}>
        {LINK_STATE_MESSAGE[r.state]}
      </Message>
    );
  const barbers = await shopBarbers(a.shopId, { onlineOnly: true });
  const service = items.find((i) => i.kind === "service");
  return (
    <Rebook
      token={token}
      firstName={customer?.firstName ?? null}
      shop={{ slug: shop!.slug, name: shop!.name, phone }}
      absent={absent?.displayLabel ?? "Your barber"}
      originalStartsAt={r.outreach.originalStartsAt.toISOString()}
      current={{ startsAt: a.startsAt.toISOString(), barber: barberNow?.displayLabel ?? "a barber", moved: !!r.outreach.reassignedStaffId && a.staffId !== r.outreach.originalStaffId, otherShop: a.shopId !== r.outreach.shopId || !!r.outreach.newAppointmentId }}
      items={items.map((i) => ({ kind: i.kind, name: i.name }))}
      serviceId={service?.serviceId ?? null}
      addonIds={items.filter((i) => i.kind === "addon" && i.serviceId).map((i) => i.serviceId!)}
      barbers={barbers.map((b) => ({ slug: b.slug, name: b.displayName }))}
      expiresAt={r.link.expiresAt.toISOString()}
    />
  );
}

function Message({ title, children, code, phone }: { title: string; children: React.ReactNode; code?: string | null; phone?: string | null }) {
  return (
    <div className="mx-auto max-w-md space-y-3 rounded-xl bg-white p-6 text-center ring-1 ring-zinc-200">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-zinc-600">{children}</p>
      {phone && (
        <a className="inline-flex h-10 items-center rounded-lg bg-brand-600 px-4 text-sm font-medium text-white" href={`tel:${phone}`}>
          Call the shop
        </a>
      )}
      {code && (
        <p className="text-sm">
          <Link className="underline" href={`/a/${code}`}>
            See your appointment
          </Link>
        </p>
      )}
    </div>
  );
}
