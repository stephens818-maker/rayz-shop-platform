import type { Metadata } from "next";
import { db } from "@/db";
import { staff } from "@/db/schema";
import { eq } from "drizzle-orm";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { IDLE_REVERIFY_DAYS, PASSWORD_LOCK_EVERY, PASSWORD_LOCK_MINUTES, STEP_UP_MINUTES, isPrivileged } from "@/domain/staff-auth";
import { formatDateTime } from "@/lib/time";
import { myWebSessions } from "@/server/auth/sessions";
import { guardPage } from "@/server/auth/staff";
import { listStaffAppSessions } from "@/server/staff-api/sign-in";
import { EndAppSession, EndOtherWebSessions, EndWebSession } from "./client";

export const metadata: Metadata = { title: "My sign-in security" };

/** Their own sign-ins (ST-C0c): every browser and phone signed in as them, each one signed out on its own, and how their account is kept safe. */
export default async function MySecurityPage() {
  const ctx = await guardPage("/admin/my-security");
  const [me, web, app] = await Promise.all([
    db.query.staff.findFirst({ where: eq(staff.id, ctx.staff.id), columns: { totpEnabledAt: true, twoFactorRequired: true } }),
    myWebSessions(ctx.staff.id, ctx.session?.id ?? null),
    listStaffAppSessions(ctx.staff.id, null),
  ]);
  const privileged = isPrivileged(ctx.permissions);
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="My sign-in security" subtitle="Where you're signed in, and signing out a browser or phone you don't recognize." />
      <Card>
        <CardHeader title="Two-step sign-in" />
        <div className="space-y-2 p-4 pt-0 text-sm">
          {me?.totpEnabledAt ? (
            <p>
              <Badge tone="green">On</Badge> You enter a code from your authenticator app when you sign in, and to confirm it&apos;s you.
            </p>
          ) : privileged || me?.twoFactorRequired ? (
            <Notice tone="amber">Your role needs two-step sign-in. You&apos;ll set up an authenticator app the next time you sign in.</Notice>
          ) : (
            <p className="text-zinc-600">Off. Your manager can require it for you.</p>
          )}
          <ul className="list-disc space-y-1 pl-5 text-zinc-600">
            <li>
              Showing a client&apos;s hidden details, exporting the client list and refunding a sale ask you to confirm it&apos;s you when you haven&apos;t signed in or confirmed in the last {STEP_UP_MINUTES} minutes.
            </li>
            <li>
              {PASSWORD_LOCK_EVERY} wrong passwords in a row lock your account for {PASSWORD_LOCK_MINUTES} minutes, doubling each time after that, up to a day.
            </li>
            <li>We email you the first time you sign in on a new browser or phone.</li>
            <li>A phone unused for {IDLE_REVERIFY_DAYS} days signs in again.</li>
          </ul>
        </div>
      </Card>
      <Card>
        <CardHeader title="Browsers" subtitle="Signed in to this portal." action={web.length > 1 ? <EndOtherWebSessions /> : undefined} />
        {web.length ? (
          <Table label="Browsers signed in">
            <thead>
              <tr>
                <Th>Browser</Th>
                <Th>Signed in</Th>
                <Th>Last used</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {web.map((s) => (
                <tr key={s.id}>
                  <Td>
                    {s.device}
                    {s.current && (
                      <Badge tone="blue" className="ml-2">
                        This browser
                      </Badge>
                    )}
                  </Td>
                  <Td>{formatDateTime(s.signedInAt)}</Td>
                  <Td>{formatDateTime(s.lastSeenAt)}</Td>
                  <Td>{!s.current && <EndWebSession id={s.id} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <Empty title="No browsers signed in" />
          </div>
        )}
      </Card>
      <Card>
        <CardHeader title="Staff app" subtitle="Phones signed in to the Ray'z Team app." />
        {app.length ? (
          <Table label="Phones signed in">
            <thead>
              <tr>
                <Th>Phone</Th>
                <Th>Signed in</Th>
                <Th>Last used</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {app.map((s) => (
                <tr key={s.id}>
                  <Td>{s.deviceName ?? "Phone"}</Td>
                  <Td>{formatDateTime(new Date(s.startedAt))}</Td>
                  <Td>{formatDateTime(new Date(s.lastUsedAt))}</Td>
                  <Td>
                    <EndAppSession id={s.id} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <Empty title="No phones signed in" />
          </div>
        )}
      </Card>
      <p className="text-xs text-zinc-500">
        Think someone else signed in? Sign that browser or phone out above and tell your manager; they can sign you out everywhere.
      </p>
    </div>
  );
}
