import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Card, CardHeader, Empty, Input, PageHeader, Select, Stat, Table, Td, Th, buttonClass } from "@/components/ui";
import { ledgerLabel } from "@/domain/gift-cards";
import { formatCents } from "@/lib/money";
import { formatDateTime } from "@/lib/time";
import { can, guardPage, openShops } from "@/server/auth/staff";
import { giftCardDetail, giftCardStats, searchGiftCards } from "@/server/gift-cards";
import { CardActions, IssueCompCard } from "./tools";

export const metadata: Metadata = { title: "Gift cards" };

const STATUSES = { active: "With a balance", spent: "Spent", void: "Voided", all: "Every card" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusBadge(status: string, balanceCents: number) {
  if (status === "void") return <Badge>Voided</Badge>;
  if (status !== "active") return <Badge tone="amber">{status}</Badge>;
  return balanceCents > 0 ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Spent</Badge>;
}

export default async function GiftCardsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string; card?: string }> }) {
  const ctx = await guardPage("/admin/gift-cards");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 60);
  const status = (sp.status && sp.status in STATUSES ? sp.status : q ? "all" : "active") as keyof typeof STATUSES;
  const [stats, rows] = await Promise.all([giftCardStats(ctx), searchGiftCards(ctx, { q, status })]);
  const exact = q ? rows.find((r) => r.code === q.toUpperCase()) : undefined;
  const detail = sp.card && UUID.test(sp.card) ? await giftCardDetail(ctx, { id: sp.card }) : exact ? await giftCardDetail(ctx, { code: exact.code }) : null;
  const working = openShops(ctx).map((s) => ({ id: s.id, name: s.name }));
  const homeShop = ctx.currentShopId ?? working[0]?.id ?? null;
  const canIssue = can(ctx, "giftcards.issue");
  const canVoid = can(ctx, "giftcards.void");
  const canReload = can(ctx, "checkout.any") && working.length > 0;

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <PageHeader
        title="Gift cards"
        subtitle="Every card works at every shop. Look up a balance by code, reload a card at checkout, add comp value, or void a lost card. Sell new cards from checkout."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Active cards" value={stats.active} />
        <Stat label="Outstanding balance" value={formatCents(stats.outstanding)} hint={ctx.brandWide ? "Gift card liability, brand-wide" : "On cards issued at your shops"} />
        <Stat label="Sold, last 30 days" value={formatCents(stats.sold)} hint={stats.reloaded ? `${formatCents(stats.reloaded)} of it reloads` : "new cards and reloads"} />
        <Stat label="Spent, last 30 days" value={formatCents(stats.redeemed)} />
        <Stat label="Comped, last 30 days" value={formatCents(stats.comped)} />
      </div>

      <Card>
        <CardHeader title="Balance lookup" subtitle="Type the whole code to find any card, wherever it was sold. Part of a code or a client's name searches cards issued at your shops." />
        <form method="get" className="flex flex-wrap items-end gap-2 p-4">
          <label className="text-sm text-zinc-700">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Code or client</span>
            <Input name="q" defaultValue={q} className="w-72 uppercase" placeholder="XXXX-XXXX-XXXX-XXXX or a name" autoFocus />
          </label>
          <label className="text-sm text-zinc-700">
            <span className="mb-1 block text-xs font-medium text-zinc-500">Show</span>
            <Select name="status" defaultValue={status} className="w-44">
              {Object.entries(STATUSES).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
          <button type="submit" className={buttonClass("secondary")}>
            Look up
          </button>
        </form>
      </Card>

      {detail && (
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                <span className="font-mono">{detail.code}</span> {statusBadge(detail.status, detail.balanceCents)}
              </span>
            }
            subtitle={`Issued at ${detail.issuedAt}, ${formatDateTime(detail.createdAt)}${detail.client ? ` · ${detail.client.name}` : ""}${detail.expiresAt ? ` · expires ${formatDateTime(detail.expiresAt)}` : ""}`}
          />
          <div className="grid gap-4 p-4 md:grid-cols-[14rem_1fr]">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Balance</div>
              <div className="text-3xl font-semibold tabular-nums text-zinc-900">{formatCents(detail.balanceCents)}</div>
              <div className="text-xs text-zinc-500">of {formatCents(detail.initialCents)} first loaded</div>
              {!detail.manageable && <p className="mt-2 text-xs text-zinc-500">Issued at another shop: you can take it at checkout and reload it, and that shop manages the rest.</p>}
            </div>
            <CardActions
              card={detail}
              shops={working}
              defaultShopId={homeShop}
              canReload={canReload}
              canComp={canIssue && detail.manageable}
              canVoid={canVoid && detail.manageable}
            />
          </div>
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What</Th>
                <Th>Where</Th>
                <Th>Ticket</Th>
                <Th right>Change</Th>
              </tr>
            </thead>
            <tbody>
              {detail.ledger.length === 0 && (
                <tr>
                  <Td className="text-sm text-zinc-500">No history recorded for this card yet.</Td>
                </tr>
              )}
              {detail.ledger.map((l) => (
                <tr key={l.id}>
                  <Td className="text-xs">{formatDateTime(l.at)}</Td>
                  <Td>{ledgerLabel(l.kind)}</Td>
                  <Td>{l.shop ?? "—"}</Td>
                  <Td>
                    {l.saleId ? (
                      <Link className="underline" href={`/admin/sales/${l.saleId}`}>
                        #{l.saleNumber}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td right className={l.deltaCents < 0 ? "text-red-600" : "text-emerald-700"}>
                    {formatCents(l.deltaCents, { sign: true })}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {canIssue && working.length > 0 && (
        <Card>
          <CardHeader title="Issue a comp card" subtitle="A card with no sale behind it, for service recovery or a giveaway. Audited with the reason. To sell a card, ring it up at checkout." />
          <IssueCompCard shops={working} defaultShopId={homeShop ?? working[0].id} />
        </Card>
      )}

      <Card>
        <CardHeader title={q ? `Cards matching “${q}”` : STATUSES[status]} subtitle={ctx.brandWide ? "Every shop's cards, newest first." : "Cards issued at your shops, newest first."} />
        {rows.length === 0 ? (
          <Empty title={q ? "No card matches that" : "No cards here yet"} />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th right>First loaded</Th>
                <Th right>Balance</Th>
                <Th>Status</Th>
                <Th>Source</Th>
                <Th>Issued at</Th>
                <Th>Client</Th>
                <Th>Last spent</Th>
                <Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={detail?.id === r.id ? "bg-amber-50" : undefined}>
                  <Td className="font-mono">
                    <Link className="underline" href={r.manageable ? `/admin/gift-cards?card=${r.id}` : `/admin/gift-cards?q=${encodeURIComponent(r.code)}`}>
                      {r.code}
                    </Link>
                  </Td>
                  <Td right>{formatCents(r.initialCents)}</Td>
                  <Td right className="font-semibold">
                    {formatCents(r.balanceCents)}
                  </Td>
                  <Td>{statusBadge(r.status, r.balanceCents)}</Td>
                  <Td className="capitalize">{r.source === "promo" ? "comp" : r.source}</Td>
                  <Td>{r.issuedAt}</Td>
                  <Td>{r.client ?? "—"}</Td>
                  <Td className="text-xs">{r.lastUsedAt ? formatDateTime(r.lastUsedAt) : "—"}</Td>
                  <Td className="text-xs">{formatDateTime(r.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
