import type { Metadata } from "next";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import { Badge, Card, CardHeader, Empty, Notice, PageHeader, Table, Td, Th } from "@/components/ui";
import { REQUIREMENT_LABEL } from "@/domain/network-access";
import { clientIp } from "@/lib/client-ip";
import { formatDateTime } from "@/lib/time";
import { TRUSTED_DEVICE_COOKIE } from "@/server/auth/cookies";
import { devicesFromCookie } from "@/server/auth/network";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { blockedAttempts, brandNetwork, listTrustedDevices, remoteAccessHolders, shopRules } from "@/server/sign-in-security";
import { AlertToggle, DeviceButtons, ShopRuleEditor, TrustThisDevice } from "./client";

export const metadata: Metadata = { title: "Sign-in security" };

type AttemptDetails = { ip?: string | null; shop?: string | null; missing?: string; via?: "sign_in" | "session"; path?: string | null };

export default async function SignInSecurityPage() {
  const ctx = await guardPage("/admin/sign-in-security");
  const canSet = can(ctx, "network.settings");
  const canApprove = canSet || can(ctx, "devices.approve");
  const exempt = ctx.isOwner || can(ctx, "access.remote");
  const myIp = clientIp(await headers());
  const mine = openShops(ctx);
  const [rules, devices, here, attempts, alert, holders] = await Promise.all([
    shopRules(mine.map((s) => s.id)),
    canApprove ? listTrustedDevices(ctx.shopIds) : [],
    devicesFromCookie((await cookies()).get(TRUSTED_DEVICE_COOKIE)?.value),
    blockedAttempts(ctx),
    canSet ? brandNetwork() : null,
    canSet || can(ctx, "permissions.manage") ? remoteAccessHolders() : null,
  ]);
  const pending = devices.filter((d) => d.status === "pending");
  const approved = devices.filter((d) => d.status === "approved");
  const hereApproved = (here?.rows ?? []).filter((r) => r.status === "approved");
  const hereShops = new Map(mine.map((s) => [s.id, s.name]));

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Sign-in security"
        subtitle="Where staff can sign in from: each location's network and approved devices, who can sign in from anywhere, and every blocked sign-in."
      />
      <Notice tone="blue">
        You&apos;re signed in from {myIp ? <code className="rounded bg-white/70 px-1">{myIp}</code> : "an address the server can't see"}
        {exempt ? ", and you can sign in from anywhere." : "."}
        {hereApproved.length ? ` This browser is an approved device for ${hereApproved.map((r) => hereShops.get(r.shopId) ?? "a shop").join(", ")}.` : ""} The rule is checked on every page, action and
        download, not only at sign-in.
      </Notice>

      {canSet ? (
        <Card>
          <CardHeader title="Locations" subtitle="Turn the restriction on per location. Staff then reach that location only from its network, an approved device, or both, as chosen." />
          <div className="divide-y divide-zinc-100">
            {rules.map((r) => (
              <div key={r.id}>
                <div className="px-4 pt-3 text-sm font-semibold text-zinc-900">
                  {r.name}{" "}
                  {r.rule.enabled ? <Badge tone="amber">Limited: {REQUIREMENT_LABEL[r.rule.require].toLowerCase()}</Badge> : <Badge>Anywhere</Badge>}
                </div>
                <ShopRuleEditor shopId={r.id} shopName={r.name} initial={r.rule} myIp={myIp} exempt={exempt} />
              </div>
            ))}
          </div>
        </Card>
      ) : (
        <Card>
          <CardHeader title="Your locations" subtitle="The brand sets these." />
          <Table>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <Td className="font-medium">{r.name}</Td>
                  <Td>{r.rule.enabled ? REQUIREMENT_LABEL[r.rule.require] : "From anywhere"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {holders && (
        <Card>
          <CardHeader
            title="Who can sign in from anywhere"
            subtitle={
              <>
                The &ldquo;Can access remotely&rdquo; permission. Change it per role or per person under <Link href="/admin/permissions" className="underline">Permissions</Link>.
              </>
            }
          />
          <div className="space-y-1 p-4 text-sm text-zinc-700">
            <div>
              <span className="font-medium">Roles:</span> {holders.roles.join(", ") || "None"}
            </div>
            <div>
              <span className="font-medium">Also given to:</span>{" "}
              {holders.granted.length
                ? holders.granted.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && ", "}
                      <Link href={`/admin/permissions/people/${p.id}`} className="underline">
                        {p.label}
                      </Link>
                    </span>
                  ))
                : "Nobody"}
            </div>
            {holders.removed.length > 0 && (
              <div>
                <span className="font-medium">Taken away from:</span> {holders.removed.map((p) => p.label).join(", ")}
              </div>
            )}
          </div>
        </Card>
      )}

      {alert && (
        <Card>
          <CardHeader title="Alerts" />
          <AlertToggle initial={alert} />
        </Card>
      )}

      {canApprove && (
        <Card>
          <CardHeader
            title="Trusted devices"
            subtitle="For locations that take approved devices: a fallback for shops whose internet address changes. A blocked sign-in can ask for approval; a manager or the brand approves it here."
          />
          {pending.length > 0 && (
            <div className="border-b border-zinc-100">
              <div className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-amber-700">Waiting for approval</div>
              <DeviceTable rows={pending} me={ctx.staff.id} />
            </div>
          )}
          {approved.length ? (
            <DeviceTable rows={approved} me={ctx.staff.id} />
          ) : (
            <Empty title="No approved devices yet">Approve the shop&apos;s own tablet or computer while signed in on it, below, or approve a request from it.</Empty>
          )}
          <div className="border-t border-zinc-100">
            <div className="px-4 pt-3 text-sm font-medium text-zinc-800">This device</div>
            <TrustThisDevice shops={mine.filter((s) => !hereApproved.some((r) => r.shopId === s.id)).map((s) => ({ id: s.id, name: s.name }))} />
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Blocked sign-ins" subtitle="Every sign-in or signed-in page refused by a location's rule, newest first. Also in the audit log." />
        {attempts.length ? (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>Location</Th>
                <Th>IP</Th>
                <Th>Missing</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => {
                const d = (a.details ?? {}) as AttemptDetails;
                const [role, ...name] = (a.who ?? "").split(":");
                return (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap">{formatDateTime(a.at)}</Td>
                    <Td>
                      <div className="font-medium">{name.join(":") || role}</div>
                      {name.length > 0 && <div className="text-xs text-zinc-500">{role}</div>}
                    </Td>
                    <Td>{d.shop ?? "—"}</Td>
                    <Td className="font-mono text-xs">{d.ip ?? "unknown"}</Td>
                    <Td>
                      {d.missing ?? "—"}
                      <div className="text-xs text-zinc-500">{d.via === "session" ? `Signed in, opening ${d.path ?? "a page"}` : "Signing in"}</div>
                    </Td>
                    <Td>{a.action === "network.limited" ? <Badge tone="amber">Signed in without it</Badge> : <Badge tone="red">Blocked</Badge>}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <Empty title="No blocked sign-ins" />
        )}
      </Card>
    </div>
  );
}

function DeviceTable({ rows, me }: { rows: Awaited<ReturnType<typeof listTrustedDevices>>; me: string }) {
  return (
    <Table>
      <thead>
        <tr>
          <Th>Device</Th>
          <Th>Shop</Th>
          <Th>Asked by</Th>
          <Th>Last used</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.id}>
            <Td>
              <div className="font-medium">{d.label}</div>
              {d.userAgent && (
                <div className="max-w-56 truncate text-xs text-zinc-500" title={d.userAgent}>
                  {d.userAgent}
                </div>
              )}
            </Td>
            <Td>{d.shop}</Td>
            <Td>
              <div>{d.requester ?? "—"}</div>
              <div className="text-xs text-zinc-500">
                {formatDateTime(d.createdAt)}
                {d.requestedIp ? ` · ${d.requestedIp}` : ""}
              </div>
            </Td>
            <Td className="text-xs text-zinc-600">
              {d.lastSeenAt ? `${formatDateTime(d.lastSeenAt)}${d.lastIp ? ` · ${d.lastIp}` : ""}` : "Not yet"}
              {d.status === "approved" && d.decider && <div>Approved by {d.decider}</div>}
            </Td>
            <Td right>
              <DeviceButtons id={d.id} status={d.status as "pending" | "approved"} own={d.requestedBy === me} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
