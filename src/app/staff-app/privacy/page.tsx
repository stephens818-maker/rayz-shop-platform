import type { Metadata } from "next";
import { LegalPage } from "@/components/legal-page";
import { STAFF_LEGAL_VERSIONS } from "@/domain/legal";
import { staffSupport } from "@/server/staff-api/config";

export const metadata: Metadata = { title: "Ray'z Staff app privacy notice", robots: { index: false } };

export default function StaffPrivacyPage() {
  const support = staffSupport();
  return (
    <main className="px-4 py-10">
      <LegalPage title="Ray'z Staff app privacy notice" updated={STAFF_LEGAL_VERSIONS.updated}>
        <p>
          This notice is for Ray&apos;z Barber Shop employees and the shop logins that use the Ray&apos;z Staff app and the staff side of the website. It explains what the app collects about you, why,
          and who can see it. Clients have their own privacy policy. This notice doesn&apos;t change your employment terms or the employee handbook.
        </p>

        <h2>What the app collects about you</h2>
        <ul>
          <li>
            <strong>Your staff profile:</strong> your name, the name you go by, your work email and mobile number, your role, the shops you work at, and your schedule, time off and blocked time.
          </li>
          <li>
            <strong>Sign-in and security:</strong> when and how you signed in (password, a code by text or email, or an invite link), the name your phone gives itself, an install id the app
            creates so a stolen sign-in can&apos;t be used on another phone, and the IP address of sign-in requests, kept to stop abuse. Codes are never stored in readable form.
          </li>
          <li>
            <strong>The time clock:</strong> each punch (in, out, breaks), the shop, how it was proven (the front-desk QR code, an NFC tag, the shop&apos;s Wi-Fi or a PIN at the front-desk clock),
            and any manager edit with who made it and why.
          </li>
          <li>
            <strong>Location, only if your shop uses it:</strong> where a shop&apos;s clock rule asks for location, the app reads your phone&apos;s location once, at the moment you punch, with
            its accuracy, to check you&apos;re at the shop. It is never tracked in the background or between punches, and you can deny the permission and punch at the front-desk clock instead.
          </li>
          <li>
            <strong>Punch photos, only if your shop asks for them:</strong> a photo taken when you punch, kept with that punch so a manager can check it. We never scan faces or fingerprints,
            and never build a face template or any other biometric identifier, from photos or anything else.
          </li>
          <li>
            <strong>Pay:</strong> your hours, the services and products you sold, your card, cash and gift-card tips, and what payroll paid you, worked out from shop records so the app matches
            the payroll export. Tips are paid through payroll (iSolved): your bank details live in iSolved&apos;s employee self-service, not in Ray&apos;z. If Ray&apos;z ever pays tips by Stripe
            instead, Stripe collects your ID and bank or card details on its own pages, and Ray&apos;z keeps only Stripe&apos;s account id, its status and the last 4 digits.
          </li>
          <li>
            <strong>Notifications:</strong> if you allow them, your phone&apos;s push token, platform and app version, and which alerts you chose. Alerts carry a client&apos;s first name at most.
          </li>
          <li>
            <strong>What you do with client records:</strong> opening a client card, searching, revealing a masked detail (with the reason you gave), calling or texting through the shop line, and
            changes to bookings are logged, as the brand&apos;s client privacy rules require.
          </li>
        </ul>

        <h2>Why we use it</h2>
        <ul>
          <li>To run your day: your calendar, clients, walk-ins, checkout and time off.</li>
          <li>To record your hours and breaks accurately and pay you correctly, including overtime, tips and commission, and to keep the time and pay records wage and hour laws require.</li>
          <li>To keep your account and client information secure, and to sign a lost phone out.</li>
          <li>To send the notifications you chose, and your milestones and congratulations.</li>
        </ul>

        <h2>Who can see it</h2>
        <ul>
          <li>You can see your own timecard, earnings, tips and sign-ins in the app.</li>
          <li>
            Managers and owners see what their role allows at the shops they manage: for example, timecards for approval and payroll, the schedule, or sales reports. Other barbers don&apos;t see
            your numbers unless their role is allowed to see every barber&apos;s.
          </li>
          <li>
            Service providers that run parts of the app for us, under contracts that limit them to that: our hosting and database providers (in the United States), Twilio (texts and sign-in
            codes), our email provider, Apple and Google (notifications), iSolved (payroll) and Stripe (payments).
          </li>
        </ul>
        <p>We don&apos;t sell employee information or use it for advertising.</p>

        <h2>How long we keep it</h2>
        <p>
          Time, pay and tip records are kept for as long as wage and hour and tax laws require, and then for as long as needed to answer pay questions. Sign-in records and push tokens are removed
          when you sign out or leave, apart from the security log.
        </p>

        <h2>Your choices</h2>
        <ul>
          <li>Location, notifications and the camera are each your phone&apos;s permission to give or take back. Without them, use the front-desk clock.</li>
          <li>You can see and end your own sign-ins in the app, and change which alerts you get.</li>
          <li>To see or correct your information, or for any question about this notice, contact your manager or the address below.</li>
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
