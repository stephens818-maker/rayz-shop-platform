"use client";

import { Badge, Button, Card, CardHeader, Notice, Table, Td, Th } from "@/components/ui";
import { useAction } from "@/components/use-action";
import { formatDate, formatDateTime } from "@/lib/time";
import type { OpeningsBlastView } from "@/server/marketing/openings";
import { approveOpeningsAction, rejectOpeningsAction, removeOpeningsWaitlistAction, textOpeningsWaitlistAction, withdrawOpeningsAction } from "./actions";

const TONE: Record<string, "green" | "amber" | "red" | "gray" | "blue"> = { sent: "green", sending: "blue", pending_approval: "amber", rejected: "red", expired: "gray", cancelled: "gray" };

export function OpeningsHistory({ blasts, showShop, canSend }: { blasts: OpeningsBlastView[]; showShop: boolean; canSend: boolean }) {
  const { pending, error, run } = useAction();
  return (
    <Card>
      <CardHeader title="Recent openings blasts" subtitle="The last two weeks. Booked is recipients who booked with that barber on those days after the message." />
      {error && (
        <div className="px-4 pt-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
      {blasts.length ? (
        <Table>
          <thead>
            <tr>
              <Th>Sent</Th>
              {showShop && <Th>Location</Th>}
              <Th>Barber</Th>
              <Th>Days</Th>
              <Th>Status</Th>
              <Th right>Open at send</Th>
              <Th right>Messages</Th>
              <Th right>Clicked</Th>
              <Th right>Booked</Th>
              <Th>Waitlist</Th>
            </tr>
          </thead>
          <tbody data-testid="openings-history">
            {blasts.map((b) => (
              <tr key={b.id}>
                <Td>
                  <div>{formatDateTime(b.createdAt)}</div>
                  <div className="text-xs text-zinc-500">by {b.sentBy}</div>
                </Td>
                {showShop && <Td>{b.shopName}</Td>}
                <Td>{b.barber}</Td>
                <Td>{b.days}</Td>
                <Td>
                  <Badge tone={TONE[b.status] ?? "gray"}>{b.statusLabel}</Badge>
                  {b.reviewNote && <div className="mt-1 max-w-[16rem] text-xs text-zinc-500">{b.reviewNote}</div>}
                  {b.status === "pending_approval" && canSend && (
                    <button type="button" disabled={pending} className="mt-1 block text-xs text-zinc-500 underline" onClick={() => run(() => withdrawOpeningsAction(b.id))}>
                      Withdraw
                    </button>
                  )}
                </Td>
                <Td right>{b.openAtSend}</Td>
                <Td right>{b.sent}</Td>
                <Td right>{b.clicked}</Td>
                <Td right>
                  <span className="font-semibold">{b.booked}</span>
                </Td>
                <Td>
                  {b.waitlist.length ? (
                    <div className="space-y-1 text-xs">
                      {b.waitlist.map((w) => (
                        <div key={w.id} className="flex items-center gap-1.5">
                          <span>
                            {w.name}
                            {w.wantsDate ? `, ${formatDate(w.wantsDate, "EEE")}` : ""}
                          </span>
                          {w.status === "texted" && <Badge tone="blue">Texted</Badge>}
                          {canSend && (
                            <button type="button" aria-label={`Remove ${w.name}`} disabled={pending} className="text-zinc-400 hover:text-zinc-700" onClick={() => run(() => removeOpeningsWaitlistAction(w.id))}>
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                      {canSend && b.waitlist.some((w) => w.status === "waiting") && (
                        <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => textOpeningsWaitlistAction(b.id))}>
                          Text them: a time opened
                        </Button>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-zinc-400">—</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <p className="p-4 text-sm text-zinc-500">No openings blasts in the last two weeks.</p>
      )}
    </Card>
  );
}

export function OpeningsApprovals({ blasts }: { blasts: OpeningsBlastView[] }) {
  const { pending, error, run } = useAction();
  return (
    <Card>
      <CardHeader title="Waiting for your approval" subtitle="Approving pulls the barber's open times and clients again and sends at once (after quiet hours). If the times are gone it expires." />
      {error && (
        <div className="px-4 pt-3">
          <Notice tone="red">{error}</Notice>
        </div>
      )}
      <Table>
        <thead>
          <tr>
            <Th>Asked</Th>
            <Th>Location</Th>
            <Th>Barber</Th>
            <Th>Days</Th>
            <Th right>Open then</Th>
            <Th />
          </tr>
        </thead>
        <tbody data-testid="openings-approvals">
          {blasts.map((b) => (
            <tr key={b.id}>
              <Td>
                <div>{formatDateTime(b.createdAt)}</div>
                <div className="text-xs text-zinc-500">by {b.sentBy}</div>
              </Td>
              <Td>{b.shopName}</Td>
              <Td>{b.barber}</Td>
              <Td>{b.days}</Td>
              <Td right>{b.openAtSend}</Td>
              <Td right>
                <div className="flex justify-end gap-2">
                  <Button size="sm" disabled={pending} onClick={() => run(() => approveOpeningsAction(b.id))}>
                    Approve and send
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => {
                      const note = prompt("Why not? The location sees this.");
                      if (note !== null) run(() => rejectOpeningsAction(b.id, note));
                    }}
                  >
                    Turn down
                  </Button>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
