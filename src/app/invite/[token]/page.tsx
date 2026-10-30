import type { Metadata } from "next";
import Link from "next/link";
import { LinkButton, Logo } from "@/components/ui";
import { PASSWORD_MIN } from "@/domain/users";
import { inviteEnrollment, openInvite } from "@/server/users";
import { SignUpForm } from "./form";

export const metadata: Metadata = { title: "Set up your sign-in", robots: { index: false } };
export const dynamic = "force-dynamic";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await openInvite(token);
  const enroll = found?.person.twoFactorRequired ? await inviteEnrollment(found.invite.id, found.person.email!) : null;
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Link href="/">
            <Logo dark />
          </Link>
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl">
          {found ? (
            <>
              <h1 className="text-lg font-semibold">Welcome, {found.person.firstName}</h1>
              <p className="mt-1 text-sm text-zinc-500">Choose a password for the Ray&apos;z brand portal.</p>
              <SignUpForm token={token} email={found.person.email!} minLength={PASSWORD_MIN} enroll={enroll} />
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">This link doesn&apos;t work</h1>
              <p className="mt-2 text-sm text-zinc-600">It has expired, was already used, or was cancelled. Ask whoever invited you to send a new one.</p>
              <LinkButton href="/login" variant="secondary" className="mt-4 w-full">
                Go to sign in
              </LinkButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
