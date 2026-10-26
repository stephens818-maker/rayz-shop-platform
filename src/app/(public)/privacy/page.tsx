import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL_UPDATED, SMS_PROGRAM } from "@/domain/legal";
import { supportContact } from "@/server/app-config";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  const support = supportContact();
  return (
    <LegalPage title="Privacy policy" updated={LEGAL_UPDATED}>
      <p>
        This policy explains what Ray&apos;z Barber Shop (&ldquo;Ray&apos;z&rdquo;, &ldquo;we&rdquo;) collects when you book, visit one of our shops in Iowa or Illinois, use this website or the
        Ray&apos;z app, and what we do with it. We don&apos;t sell your information, and we don&apos;t share it for anyone else&apos;s advertising.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your profile:</strong> first and last name, mobile number, email (if you give one), and optionally your birthday and how you heard about us.
        </li>
        <li>
          <strong>Visits and purchases:</strong> appointments, the services and products you bought, your barber, tips, gift cards, rewards, and notes the shop keeps to do your cut the same way next
          time.
        </li>
        <li>
          <strong>Your preferences:</strong> the note you write for your barber and your preferred barber.
        </li>
        <li>
          <strong>Children&apos;s profiles</strong> you add to your account: a first name and, if you choose, a birth year. See &ldquo;Children&rdquo; below.
        </li>
        <li>
          <strong>Payment cards:</strong> card details go straight to our payment processor, Stripe, and never touch our servers. We keep only what Stripe tells us: the card brand, last four digits,
          expiry, and whether it&apos;s a credit, debit or prepaid card (which decides whether a card fee applies).
        </li>
        <li>
          <strong>App and device:</strong> the app version, your device type, and, if you allow notifications, a push token that lets us send them to that device.
        </li>
        <li>
          <strong>Security:</strong> the IP address of sign-in and booking requests, used to stop abuse, and records of sign-in codes sent (never the code itself).
        </li>
        <li>
          <strong>Consent records:</strong> when you agreed to or stopped texts, emails or notifications, the wording you saw, and where (app, website, or in the shop).
        </li>
      </ul>
      <p>We don&apos;t collect fingerprints, face scans or any other biometric information, from clients or staff.</p>

      <h2>How we use it</h2>
      <ul>
        <li>To book, confirm, remind you of and manage appointments, check you out, and send receipts.</li>
        <li>To run the rewards program and gift cards.</li>
        <li>To sign you in with one-time codes and keep your account secure, including extra checks when a phone number may have changed hands.</li>
        <li>To send offers and news by text, email or notification, only if you separately agreed to that channel. Appointment messages and marketing are separate choices.</li>
        <li>To answer you when you contact us, and to keep the records the law requires (for example, tax records of sales).</li>
      </ul>

      <h2>Who we share it with</h2>
      <p>Only the companies that run parts of the service for us, under contracts that limit them to doing that:</p>
      <ul>
        <li>
          <strong>Stripe</strong> processes card payments and stores saved cards. See{" "}
          <a href="https://stripe.com/privacy" rel="noreferrer">
            Stripe&apos;s privacy policy
          </a>
          .
        </li>
        <li>
          <strong>Twilio</strong> sends text messages and sign-in codes and helps block fraudulent code requests.
        </li>
        <li>
          <strong>Our email provider</strong> sends confirmations, receipts and, if you agreed, newsletters.
        </li>
        <li>
          <strong>Apple Push Notification service and Google Firebase Cloud Messaging</strong> deliver app notifications to your device.
        </li>
        <li>
          <strong>Our hosting and database providers</strong> store the service&apos;s data in the United States.
        </li>
      </ul>
      <p>
        {SMS_PROGRAM.noSharing} We may also disclose information when the law requires it, to protect someone&apos;s safety, or as part of a sale of the business (the buyer would be bound by this
        policy).
      </p>

      <h2>Text messages</h2>
      <p>
        If you agree to appointment texts, we text confirmations, reminders and updates about your bookings. {SMS_PROGRAM.frequency} {SMS_PROGRAM.rates} {SMS_PROGRAM.stop} {SMS_PROGRAM.help} Marketing
        texts are a separate opt-in. Full SMS terms are in our <Link href="/terms#sms">terms of service</Link>.
      </p>

      <h2>Notifications</h2>
      <p>
        The app asks before sending notifications. You can turn them off in your phone&apos;s settings or the app at any time; appointment notifications and marketing notifications are separate
        switches.
      </p>

      <h2>How long we keep it</h2>
      <ul>
        <li>Your profile, visits and preferences: while you have an account. Delete it any time (below).</li>
        <li>Sales, payment and tip records: 7 years, as tax law requires. After you delete your account they&apos;re kept without your name, phone or email.</li>
        <li>Text and email logs: up to 2 years. Sign-in codes expire after 10 minutes.</li>
        <li>A phone number that replied STOP stays on our do-not-text list so we keep honoring it.</li>
        <li>Backups are encrypted and overwritten within 35 days.</li>
      </ul>

      <h2>Children</h2>
      <p>
        You must be 13 or older to have your own account. Our website and app aren&apos;t directed at children under 13, and we don&apos;t knowingly collect information from them. A parent or guardian
        can add their children to their own account so they can book their cuts: we keep only the child&apos;s first name and, if the parent chooses, a birth year, along with their visits.
        Children&apos;s profiles have no phone, email or marketing consent of their own; messages go to the parent. A parent can remove a child&apos;s profile at any time from their account or by
        contacting us. If you think we have information from a child under 13 without a parent&apos;s involvement, contact us and we&apos;ll delete it.
      </p>

      <h2>Your choices and rights</h2>
      <ul>
        <li>
          See and update your details on <Link href="/account">your account</Link> or in the app.
        </li>
        <li>Stop marketing on any channel: reply STOP to a text, use the unsubscribe link in an email, or turn off notifications.</li>
        <li>
          <Link href="/account/delete">Delete your account</Link> in the app or on the web, without needing the app installed.
        </li>
        <li>
          Depending on where you live (including Iowa), you may have the right to access, correct, delete or get a copy of your information, and to appeal if we decline. Contact us to use them;
          we&apos;ll answer within 45 days and won&apos;t treat you differently for asking.
        </li>
      </ul>

      <h2>Security</h2>
      <p>
        We use encryption in transit and at rest, one-time sign-in codes instead of passwords, and access controls that limit what each staff member can see. No system is perfectly secure; tell us
        right away if you suspect a problem.
      </p>

      <h2>Changes</h2>
      <p>If we make a significant change we&apos;ll tell you in the app or by email before it takes effect. The date at the top shows the latest version.</p>

      <h2>Contact</h2>
      <p>
        For questions or requests,{" "}
        {support.email && (
          <>
            email <a href={`mailto:${support.email}`}>{support.email}</a>,{" "}
          </>
        )}
        {support.phone && <>call {support.phone}, </>}
        call any of our shops, or see the <Link href="/support">support page</Link>.
      </p>
    </LegalPage>
  );
}
