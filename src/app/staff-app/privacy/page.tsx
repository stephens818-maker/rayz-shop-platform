import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { NO_BIOMETRICS_POLICY } from "@/domain/biometrics";
import { STAFF_LEGAL_VERSIONS } from "@/domain/legal";
import { QUIET_HOURS_POLICY } from "@/domain/staff-notifications";
import { NO_RETALIATION, PAY_AGENCIES, PAY_QUESTION_STEPS, STAFF_DATA_MAP, privacyReviewed } from "@/domain/staff-privacy";
import { staffSupport } from "@/server/staff-api/config";

export const metadata: Metadata = { title: "Ray'z Staff app privacy notice", robots: { index: false } };

export default function StaffPrivacyPage() {
  const support = staffSupport();
  return (
    <main className="px-4 py-10">
      <LegalPage title="Ray'z Staff app privacy notice" updated={STAFF_LEGAL_VERSIONS.updated}>
        {!privacyReviewed() && (
          <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
            Draft for review: this notice is waiting for legal review and may change before the Ray&apos;z Staff app is released.
          </p>
        )}
        <p>
          This notice is for Ray&apos;z Barber Shop employees and the shop logins that use the Ray&apos;z Staff app and the staff side of the website. It explains what we collect about you, why,
          who can see it, how long we keep it, and what to do if you think your pay is wrong. Clients have their own privacy policy. This notice doesn&apos;t change your employment terms or the
          employee handbook.
        </p>

        <h2>What we collect, why, and how long we keep it</h2>
        {STAFF_DATA_MAP.map((d) => (
          <section key={d.key} aria-labelledby={`dm-${d.key}`}>
            <h3 id={`dm-${d.key}`} className="mt-4 font-semibold text-zinc-900">
              {d.category}
            </h3>
            <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[9rem_1fr]">
              <dt className="text-zinc-500">What</dt>
              <dd>{d.what}</dd>
              <dt className="text-zinc-500">Why</dt>
              <dd>{d.why}</dd>
              <dt className="text-zinc-500">Where it comes from</dt>
              <dd>{d.source}</dd>
              <dt className="text-zinc-500">Who at Ray&apos;z sees it</dt>
              <dd>{d.access}</dd>
              <dt className="text-zinc-500">Held for us by</dt>
              <dd>{d.processors}</dd>
              <dt className="text-zinc-500">How long</dt>
              <dd>{d.retention}</dd>
            </dl>
          </section>
        ))}

        <h2>{NO_BIOMETRICS_POLICY.title}</h2>
        <p>{NO_BIOMETRICS_POLICY.summary}</p>
        <ul>
          {NO_BIOMETRICS_POLICY.points.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>

        <h2>Who else gets it</h2>
        <p>
          Only the service providers named above, under contracts that limit them to running their part of the app for us, and anyone the law requires us to give it to (for example a tax
          authority or a labor department investigating a claim). We don&apos;t sell employee information or use it for advertising.
        </p>

        <h2>Notifications off the clock</h2>
        <p>{QUIET_HOURS_POLICY.summary}</p>

        <h2>If you think your pay is wrong</h2>
        <ol className="ml-5 list-decimal space-y-2">
          {PAY_QUESTION_STEPS.map((s) => (
            <li key={s.title} className="list-decimal">
              <strong>{s.title}.</strong> {s.body}
            </li>
          ))}
        </ol>
        <ul>
          {PAY_AGENCIES.map((a) => (
            <li key={a.state}>
              <a href={a.url}>{a.name}</a>
              {"phone" in a ? `, ${a.phone}` : null}
            </li>
          ))}
        </ul>
        <p>{NO_RETALIATION}</p>

        <h2>Your choices and rights</h2>
        <ul>
          <li>Location, notifications and the camera are each your phone&apos;s permission to give or take back. Without them, use the front-desk clock.</li>
          <li>You can see your own timecard, pay, tips, pay questions and sign-ins in the app, end your own sign-ins, and change which alerts you get.</li>
          <li>
            You can ask to see your personnel and pay records, and to correct anything that&apos;s wrong, through your manager or the contact below. State law (in Illinois, the Personnel Record
            Review Act; in Iowa, Iowa Code chapter 91B) also gives you the right to inspect your personnel file.
          </li>
        </ul>

        <h2>Contact</h2>
        <p>
          {support.email ? <>Email <a href={`mailto:${support.email}`}>{support.email}</a></> : "Ask your manager"}
          {support.phone ? <>, or call {support.phone}</> : null}. See also the <a href="/staff-app/terms">terms of use</a> and <a href="/staff-app/support">support</a>.
        </p>
      </LegalPage>
    </main>
  );
}
