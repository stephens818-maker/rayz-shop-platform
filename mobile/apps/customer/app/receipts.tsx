import { formatCents, formatLongDate } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Body, Button, Card, Display, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { receiptTotal, receiptView, type ReceiptView } from "../src/receipt-view";
import { useSession } from "../src/session";

interface Row { id: string; shopName: string; paidAt: string; totalCents: number; serviceName: string }
interface Page { receipts: Row[]; nextCursor: string | null }

export default function Receipts() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["receipts", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<Page>("/api/v1/me/receipts?limit=20", session?.token),
  });
  const detail = useQuery({
    queryKey: ["receipt", open],
    enabled: Boolean(open && session),
    queryFn: () => api<{ receipt: ReceiptView | null }>(`/api/v1/me/receipts/${open}`, session?.token),
  });
  const receipt = receiptView(detail.data ?? null);
  const rows = [...(list.data?.receipts ?? []), ...more];
  const next = cursor === null ? list.data?.nextCursor ?? null : cursor;

  const loadMore = () => {
    if (!session || !next) return;
    void api<Page>(`/api/v1/me/receipts?limit=20&cursor=${next}`, session.token).then((page) => {
      setMore((current) => [...current, ...page.receipts]);
      setCursor(page.nextCursor);
    });
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("receipts")}</Display>
      {rows.map((row) => (
        <Card key={row.id}>
          <Body>{row.shopName}</Body>
          <Body muted>{`${row.serviceName} · ${formatLongDate(row.paidAt.slice(0, 10), "en-US")}`}</Body>
          <Money cents={row.totalCents} />
          <Button label={t("receipts")} kind="ghost" onPress={() => setOpen(row.id)} />
        </Card>
      ))}
      {next ? <Button label={t("loadMore")} kind="secondary" onPress={loadMore} /> : null}
      {detail.data && !receipt ? <Body>{t("receiptMissing")}</Body> : null}
      {receipt ? (
        <Card>
          <Body>{`${t("services")} ${formatCents(receipt.serviceCents)}`}</Body>
          <Body>{`Tax ${formatCents(receipt.taxCents)}`}</Body>
          <Body>{`${t("tip")} ${formatCents(receipt.tipCents)}`}</Body>
          <Body>{`${t("feeTitle")} ${formatCents(receipt.feeCents)}`}</Body>
          {receipt.refunds.map((refund) => (
            <Body key={refund.id}>{`${t("refund")} ${formatCents(refund.amountCents)}`}</Body>
          ))}
          <Money cents={receiptTotal(receipt) ?? receipt.totalCents} large />
          <Body muted>{receipt.tender}</Body>
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
