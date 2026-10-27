import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { staffSupport } from "@/server/staff-api/config";

export const metadata: Metadata = { title: "Ray'z Staff app support", robots: { index: false } };

export default function StaffSupportPage() {
  const support = staffSupport();
  return (
    <main className="px-4 py-10">
      <LegalPage title="Ray'z Staff app support">
        <p>
          {support.email || support.phone ? (
            <>
              For help with the app,{" "}
              {support.email ? (
                <>
                  email <a href={`mailto:${support.email}`}>{support.email}</a>
                </>
              ) : null}
              {support.email && support.phone ? " or " : null}
              {support.phone ? <>call {support.phone}</> : null}. Your manager can help with most things too.
            </>
          ) : (
            "For help with the app, ask your manager."
          )}
        </p>

        <h2>Signing in</h2>
        <ul>
          <li>Use your work email and password, or ask for a code by text or email on the sign-in screen.</li>
          <li>New to the app, or your link expired? Ask your manager to send a new staff app invite. Each link works once, for 3 days.</li>
          <li>If two-step sign-in is on for you, you&apos;ll also need your authenticator code.</li>
        </ul>

        <h2>A lost or shared phone</h2>
        <p>Sign it out from Settings → Sign-ins on another phone, or ask a manager to sign you out everywhere. Its notifications stop at once.</p>

        <h2>The time clock</h2>
        <p>
          If the app won&apos;t let you punch (no QR code, wrong Wi-Fi, location off), use the front-desk clock with your PIN. If a punch is missing or wrong, ask a manager to fix it on your
          timecard.
        </p>

        <h2>Pay and tips</h2>
        <p>
          Your tips come with your paycheck through payroll. Pay stubs, W-2s and bank details are in iSolved employee self-service. Ask your manager if your hours, tips or earnings look wrong.
        </p>

        <p>
          See the <a href="/staff-app/privacy">privacy notice</a> and <a href="/staff-app/terms">terms of use</a>.
        </p>
      </LegalPage>
    </main>
  );
}
