import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/legal-page";
import { LEGAL_UPDATED, SMS_PROGRAM } from "@/domain/legal";

export const metadata: Metadata = { title: "Terms of service" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" updated={LEGAL_UPDATED}>
      <p>
        These terms cover booking with Ray&apos;z Barber Shop (&ldquo;Ray&apos;z&rdquo;, &ldquo;we&rdquo;) on this website or in the Ray&apos;z app. By booking or creating an account you agree to them
        and to our <Link href="/privacy">privacy policy</Link>.
      </p>

      <h2>Your account</h2>
      <ul>
        <li>You must be 13 or older to have an account. A parent or guardian books for younger children from their own account and is responsible for those bookings.</li>
        <li>Give your real name and a phone number or email you control. Each person has their own profile, even when a family shares a phone.</li>
        <li>You sign in with one-time codes. Don&apos;t share them; we&apos;ll never ask you for one.</li>
        <li>
          You can <Link href="/account/delete">delete your account</Link> at any time.
        </li>
      </ul>

      <h2>Booking, cancelling and no-shows</h2>
      <ul>
        <li>Times are held for you when you book. Please arrive a few minutes early; a late arrival may mean a shorter service or a new time.</li>
        <li>Cancel or reschedule from your confirmation or account up to each shop&apos;s cutoff (30 minutes before by default, shown when you book). After that, call the shop.</li>
        <li>Shops may limit online booking for clients who repeatedly miss appointments.</li>
        <li>Prices shown when booking are estimates; the final price depends on the services you get on the day.</li>
      </ul>

      <h2>Payments and card fees</h2>
      <ul>
        <li>You pay at the shop or, where offered, with a card saved in the app. Saved cards are stored by our processor, Stripe; we never see the full number.</li>
        <li>
          Where the law allows, a fee may be added when you pay with a credit card. It&apos;s shown, with the total, before you confirm. There&apos;s no fee on debit or prepaid cards. If a payment is
          refunded, the matching share of the fee is refunded too.
        </li>
        <li>Tips go to the people who served you.</li>
      </ul>

      <h2>Gift cards and rewards</h2>
      <ul>
        <li>Gift cards work at every Ray&apos;z shop, can&apos;t be exchanged for cash except where the law requires, and keep their balance until used.</li>
        <li>
          Rewards are earned and used as described in the app and on your account. They have no cash value, can&apos;t be transferred or sold, and the program&apos;s rules may change with notice;
          rewards you&apos;ve already earned stay usable until they expire.
        </li>
        <li>Deleting your account forfeits rewards progress and unused rewards.</li>
      </ul>

      <h2 id="sms">Text messages (SMS terms)</h2>
      <ul>
        <li>
          <strong>Program:</strong> {SMS_PROGRAM.name}: confirmations, reminders and updates about your bookings, sent only if you agree. Promotional texts are a separate program you can join on its
          own.
        </li>
        <li>{SMS_PROGRAM.frequency}</li>
        <li>{SMS_PROGRAM.rates}</li>
        <li>{SMS_PROGRAM.stop}</li>
        <li>{SMS_PROGRAM.help}</li>
        <li>{SMS_PROGRAM.carriers}</li>
        <li>Agreeing to texts is never required to book or buy anything.</li>
        <li>{SMS_PROGRAM.noSharing}</li>
        <li>
          Sign-in codes are sent when you ask for one, and only for that. See the <Link href="/privacy">privacy policy</Link> for how we handle your number.
        </li>
      </ul>

      <h2>Using the service</h2>
      <p>
        Don&apos;t book under someone else&apos;s name without their say-so, make bookings you don&apos;t intend to keep, try to get at other people&apos;s information, or interfere with the website
        or app. We may suspend accounts that do.
      </p>

      <h2>Disclaimers and liability</h2>
      <p>
        The website and app are provided as they are. We work to keep them available and accurate but can&apos;t promise they&apos;ll always be. To the extent the law allows, Ray&apos;z isn&apos;t
        liable for indirect or consequential losses from using them, and our total liability for a claim about them is limited to the amount you paid us in the 12 months before it. Nothing here limits
        rights you have by law that can&apos;t be waived.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update these terms; if a change is significant we&apos;ll tell you in the app or by email before it applies. These terms are governed by the laws of the State of Iowa, except where the
        law of your state says otherwise. Questions: see <Link href="/support">support</Link>.
      </p>
    </LegalPage>
  );
}
