import type { Metadata } from "next";
import { Logo } from "@/components/ui";
import { staffStoreUrls } from "@/server/staff-api/config";
import { appInviteView } from "@/server/staff-api/sign-in";

export const metadata: Metadata = { title: "Your Ray'z Staff app invite", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Where a staff app invite's text or email points. Opening it uses nothing up: the app takes the token
 * from the link (rayzstaff://invite/{token}, or this URL as a universal link) and accepts it there.
 */
export default async function StaffAppInvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await appInviteView(token).catch(() => null);
  const scheme = process.env.STAFF_APP_SCHEME?.trim() || "rayzstaff";
  const stores = staffStoreUrls();
  return (
    <div className="grid min-h-dvh place-items-center bg-ink-900 px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex justify-center">
          <Logo dark />
        </div>
        <div className="rounded-2xl bg-white p-6 shadow-xl">
          {invite ? (
            <>
              <h1 className="text-lg font-semibold">Welcome, {invite.firstName}</h1>
              <p className="mt-1 text-sm text-zinc-600">
                Open this link in the Ray&apos;z Staff app to sign in{invite.setPassword ? " and choose your password" : ""}. It works once, until{" "}
                {new Date(invite.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/Chicago" })}.
              </p>
              <a className="mt-4 block rounded-lg bg-zinc-900 px-4 py-2 text-center text-sm font-medium text-white" href={`${scheme}://invite/${encodeURIComponent(token)}`}>
                Open the Ray&apos;z Staff app
              </a>
              {(stores.ios || stores.android) && (
                <p className="mt-4 text-sm text-zinc-600">
                  Don&apos;t have it yet? Get it for{" "}
                  {stores.ios ? (
                    <a className="underline" href={stores.ios}>
                      iPhone
                    </a>
                  ) : null}
                  {stores.ios && stores.android ? " or " : null}
                  {stores.android ? (
                    <a className="underline" href={stores.android}>
                      Android
                    </a>
                  ) : null}
                  , then open this link again.
                </p>
              )}
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold">This link doesn&apos;t work</h1>
              <p className="mt-2 text-sm text-zinc-600">It has expired, was already used, or a newer one was sent. Ask your manager to send a new staff app invite.</p>
            </>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-zinc-400">
          <a href="/staff-app/privacy">Privacy</a> · <a href="/staff-app/terms">Terms</a> · <a href="/staff-app/support">Support</a>
        </p>
      </div>
    </div>
  );
}
