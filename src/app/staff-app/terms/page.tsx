import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { STAFF_LEGAL_VERSIONS } from "@/domain/legal";

export const metadata: Metadata = { title: "Ray'z Staff app terms of use", robots: { index: false } };

export default function StaffTermsPage() {
  return (
    <main className="px-4 py-10">
      <LegalPage title="Ray'z Staff app terms of use" updated={STAFF_LEGAL_VERSIONS.updated}>
        <p>
          The Ray&apos;z Staff app is for Ray&apos;z Barber Shop employees and shop logins, for Ray&apos;z work only. Using it means you agree to these terms. They sit alongside the employee
          handbook and your employment terms, which win where they differ. These terms aren&apos;t an employment contract.
        </p>

        <h2>Your account</h2>
        <ul>
          <li>Your sign-in is yours alone. Don&apos;t share your password, codes, PIN or a signed-in phone, and don&apos;t sign in as someone else.</li>
          <li>Tell your manager straight away if your phone is lost or you think someone else used your sign-in. You or a manager can sign that phone out remotely.</li>
          <li>Ray&apos;z may sign you out, limit what you can do, or close access, for example when your role changes or you leave.</li>
        </ul>

        <h2>Client information</h2>
        <ul>
          <li>Client details are confidential. Open a client&apos;s record only to serve them, and give a truthful reason when you reveal a masked detail.</li>
          <li>Don&apos;t copy, screenshot, export or send client information outside the app. Call and text clients only through the shop line in the app.</li>
          <li>Every look at and change to a client record is logged.</li>
        </ul>

        <h2>The time clock</h2>
        <ul>
          <li>Punch only for yourself, at the shop you&apos;re working at, when you start and stop work and take breaks. Punching for someone else isn&apos;t allowed.</li>
          <li>If a punch is wrong or missing, ask a manager to fix it. Every edit is recorded with who made it and why, and you sign off your own timecard.</li>
          <li>If the app&apos;s clock is unavailable, use the front-desk clock.</li>
        </ul>

        <h2>Pay and tips</h2>
        <p>
          The app shows your hours, sales, tips and earnings for information, worked out from the same records as payroll. Your pay stub from payroll is the official record. Tell your manager
          if something looks wrong. Tips are paid through payroll unless Ray&apos;z tells you otherwise.
        </p>

        <h2>The app itself</h2>
        <ul>
          <li>Keep the app updated. Old versions may be asked to update before they work.</li>
          <li>Don&apos;t try to get around its permissions, read other people&apos;s data, or interfere with it.</li>
          <li>The app is provided as it is. Ray&apos;z works to keep it running and accurate, but it may sometimes be unavailable.</li>
        </ul>

        <h2>Changes</h2>
        <p>We may update these terms. The date at the top changes when we do, and the app shows the new version.</p>

        <p>
          See also the <a href="/staff-app/privacy">privacy notice</a> and <a href="/staff-app/support">support</a>.
        </p>
      </LegalPage>
    </main>
  );
}
