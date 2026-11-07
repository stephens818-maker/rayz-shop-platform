import type { Metadata } from "next";
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { roles, shops, staff } from "@/db/schema";
import { Badge, Card, CardHeader, Empty, LinkButton, PageHeader, Table, Td, Th } from "@/components/ui";
import { CONTACT_GRANT_LABEL } from "@/domain/contact-grants";
import { isBrandLevelPerson } from "@/domain/permissions";
import { formatDate, formatDateTime } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { accessEntries, whoLabel } from "@/server/client-access-report";
import { grantCaller, listContactGrants } from "@/server/contact-grants";
import { GrantForm, RevokeGrant } from "./editor";

export const metadata: Metadata = { title: "Contact access" };

const STATUS_TONE = { active: "green", expired: "gray", revoked: "red" } as const;

export default async function ContactAccessPage() {
  const ctx = await guardPage("/admin/client-data/contact-access");
  const [grants, people, shopRows, exports] = await Promise.all([
    listContactGrants(),
    db
      .select({ id: staff.id, label: staff.displayLabel, kind: staff.kind, scope: staff.shopScope, roleKey: roles.key, brandLevel: roles.brandLevel })
      .from(staff)
      .innerJoin(roles, eq(roles.id, staff.roleId))
      .where(and(eq(staff.active, true), isNull(staff.removedAt)))
      .orderBy(asc(staff.kind), asc(staff.displayLabel)),
    db.select({ id: shops.id, name: shops.name }).from(shops).where(ne(shops.status, "archived")).orderBy(asc(shops.name)),
    accessEntries({ days: "30", kind: "export" }, 50),
  ]);
  const caller = grantCaller(ctx);
  const grantable = people
    .filter((p) => !isBrandLevelPerson({ kind: p.kind, scope: p.scope, role: { key: p.roleKey, brandLevel: p.brandLevel } }))
    .map((p) => ({ id: p.id, label: p.kind === "shop" ? `${p.label} (shop login)` : p.label }));
  const active = grants.filter((g) => g.status === "active");
  const ended = grants.filter((g) => g.status !== "active").slice(0, 100);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Contact access"
        subtitle="Shop logins and staff see client phone numbers, emails and addresses masked, and can't export or download client lists. Here the brand can give either, separately, to one person or to everyone at a location, and take it back at any time. Every grant, revoke and export is in the audit log."
        actions={
          <div className="flex gap-2">
            <LinkButton variant="secondary" href="/admin/client-data">
              Protection settings
            </LinkButton>
            <LinkButton variant="secondary" href="/admin/client-data/access?kind=export&days=90">
              Every export
            </LinkButton>
          </div>
        }
      />

      {caller.managesPrivacy ? (
        <Card>
          <CardHeader title="Give access" subtitle="You can only give what you have yourself. Brand-level people don't need it, so they aren't listed." />
          <GrantForm people={grantable} shops={shopRows} mayGive={{ full_contact: caller.seesFullContact, export: caller.mayExport }} />
        </Card>
      ) : (
        <Card className="p-4 text-sm text-zinc-600">Only brand-level people (with access to every shop) can give or revoke contact access.</Card>
      )}

      <Card>
        <CardHeader title={`In force (${active.length})`} subtitle="Applies from their next page load. With a location grant, a person who works at several locations has it only while they're working at that one." />
        {active.length === 0 ? (
          <Empty title="Nobody has been given contact access" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>To</Th>
                <Th>Until</Th>
                <Th>Given by</Th>
                <Th>Why</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {active.map((g) => (
                <tr key={g.id} className="align-top">
                  <Td>{CONTACT_GRANT_LABEL[g.kind]}</Td>
                  <Td>{g.target}</Td>
                  <Td>{g.expiresAt ? formatDate(g.expiresAt, "MMM d, yyyy") : "Until revoked"}</Td>
                  <Td>
                    {whoLabel(g.grantedByLabel)}
                    <div className="text-[11px] text-zinc-500">{formatDateTime(g.createdAt)}</div>
                  </Td>
                  <Td className="max-w-xs whitespace-normal text-zinc-600">{g.note ?? ""}</Td>
                  <Td right>{caller.managesPrivacy && <RevokeGrant id={g.id} />}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card>
        <CardHeader title="Client list exports, last 30 days" subtitle="Every download of clients, by anyone, with how many clients it held." />
        {exports.length === 0 ? (
          <Empty title="No exports in the last 30 days" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th right>Clients</Th>
                <Th>Shop</Th>
              </tr>
            </thead>
            <tbody>
              {exports.map((e) => (
                <tr key={e.id}>
                  <Td>{formatDateTime(e.at)}</Td>
                  <Td>{whoLabel(e.actorLabel)}</Td>
                  <Td>{String(e.detail?.export ?? "export").replaceAll("_", " ")}</Td>
                  <Td right>{String(e.detail?.clients ?? e.detail?.rows ?? "")}</Td>
                  <Td>{e.shop ?? "All shops"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {ended.length > 0 && (
        <Card>
          <CardHeader title="Ended" subtitle="Revoked and expired grants stay here for the record." />
          <Table>
            <thead>
              <tr>
                <Th>What</Th>
                <Th>To</Th>
                <Th>Status</Th>
                <Th>Given</Th>
                <Th>Ended</Th>
              </tr>
            </thead>
            <tbody>
              {ended.map((g) => (
                <tr key={g.id}>
                  <Td>{CONTACT_GRANT_LABEL[g.kind]}</Td>
                  <Td>{g.target}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[g.status]}>{g.status === "revoked" ? "Revoked" : "Expired"}</Badge>
                  </Td>
                  <Td>
                    {whoLabel(g.grantedByLabel)} · {formatDateTime(g.createdAt)}
                  </Td>
                  <Td>{g.revokedAt ? `${whoLabel(g.revokedByLabel)} · ${formatDateTime(g.revokedAt)}` : g.expiresAt ? formatDateTime(g.expiresAt) : ""}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
