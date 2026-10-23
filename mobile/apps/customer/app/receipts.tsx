import { formatCents, formatLongDate } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Body, Button, Card, Display, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";

interface Row { id: string; shopName: string; paidAt: string; totalCents: number; serviceName: string }
interface Detail { serviceCents: number; taxCents: number; tipCents: number; feeCents: number; totalCents: number; tender: string; paidAt: string }

export default function Receipts() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["receipts", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ receipts: Row[] }>("/api/v1/me/receipts", session?.token),
  });
  const detail = useQuery({
    queryKey: ["receipt", open],
    enabled: Boolean(open && session),
    queryFn: () => api<Detail>(`/api/v1/me/receipts/${open}`, session?.token),
  });

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("receipts")}</Display>
      {list.data?.receipts.map((row) => (
        <Card key={row.id}>
          <Body>{row.shopName}</Body>
          <Body muted>{`${row.serviceName} · ${formatLongDate(row.paidAt.slice(0, 10), "en-US")}`}</Body>
          <Money cents={row.totalCents} />
          <Button label={t("receipts")} kind="ghost" onPress={() => setOpen(row.id)} />
        </Card>
      ))}
      {detail.data ? (
        <Card>
          <Body>{`${t("services")} ${formatCents(detail.data.serviceCents)}`}</Body>
          <Body>{`Tax ${formatCents(detail.data.taxCents)}`}</Body>
          <Body>{`${t("tip")} ${formatCents(detail.data.tipCents)}`}</Body>
          <Body>{`${t("feeTitle")} ${formatCents(detail.data.feeCents)}`}</Body>
          <Money cents={detail.data.totalCents} large />
          <Body muted>{detail.data.tender}</Body>
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
