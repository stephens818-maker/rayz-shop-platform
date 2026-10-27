/**
 * Demo databases only: the seed gives nobody marketing consent, so every Campaign Center send would
 * be skipped as "No marketing consent". This opts about a third of the adult demo clients in to
 * marketing texts (and email where they have one), each with a consent record, so campaigns, blasts
 * and We have openings can be tried in the sandbox. Runs once: it does nothing if anyone already
 * has marketing consent. Never run on real data.
 */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { CONSENT_TEXTS } from "@/domain/consent-texts";

async function main() {
  if (process.env.DEMO_MODE !== "true") throw new Error("demo-consent only runs with DEMO_MODE=true");
  const [{ any }] = (await db.execute(
    sql`select exists(select 1 from customers where sms_marketing_opt_in or email_marketing_opt_in) as any`,
  )) as unknown as { any: boolean }[];
  if (any) return console.log("Marketing consent: demo clients already have some.");
  const n = await db.transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      update customers set
        sms_marketing_opt_in = phone is not null,
        email_marketing_opt_in = email is not null and email_verified_at is not null
      where guardian_id is null and deleted_at is null and (phone is not null or email is not null)
        and ('x' || substr(md5(id::text), 1, 8))::bit(32)::int % 3 = 0
      returning id, phone, email, sms_marketing_opt_in as sms, email_marketing_opt_in as em`)) as unknown as {
      id: string;
      phone: string | null;
      email: string | null;
      sms: boolean;
      em: boolean;
    }[];
    const events = rows.flatMap((r) => [
      ...(r.sms ? [{ id: r.id, channel: "sms_marketing", phone: r.phone, email: null, version: CONSENT_TEXTS.sms_marketing.version }] : []),
      ...(r.em ? [{ id: r.id, channel: "email_marketing", phone: null, email: r.email, version: CONSENT_TEXTS.email_marketing.version }] : []),
    ]);
    for (let i = 0; i < events.length; i += 500) {
      const chunk = events.slice(i, i + 500);
      await tx.execute(sql`
        insert into consent_events (customer_id, phone, email, channel, action, text_version, source)
        values ${sql.join(
          chunk.map((e) => sql`(${e.id}::uuid, ${e.phone}, ${e.email}, ${e.channel}, 'granted', ${e.version}, 'web')`),
          sql`, `,
        )}`);
    }
    return rows.length;
  });
  console.log(`Marketing consent: opted in ${n} demo clients.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
