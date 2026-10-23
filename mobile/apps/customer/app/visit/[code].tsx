import { chicagoDate, formatCents, formatClock } from "@rayz/api";
import { displayDate } from "../../src/civil-date";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Banner, Body, Button, Display, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../../src/net";
import { useSession } from "../../src/session";

interface Appointment {
  code: string;
  status: string;
  startsAt: string;
  shop: { id: string; slug: string; name: string };
  barber: { displayName: string };
  customer: { firstName: string };
  items: { name: string; priceCents: number }[];
  canCancel: boolean;
  canReschedule: boolean;
  estimateCents: number;
}

export default function Visit() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [error, setError] = useState("");
  const [when, setWhen] = useState("");
  const visit = useQuery({ queryKey: ["visit", code], queryFn: () => api<{ appointment: Appointment }>(`/api/v1/appointments/${code}`, session?.token) });
  const row = visit.data?.appointment;
  const slots = useQuery({
    queryKey: ["move", row?.shop.slug, row ? chicagoDate(row.startsAt) : ""],
    enabled: Boolean(row?.canReschedule),
    queryFn: () => api<{ slots: { startsAt: string }[] }>(`/api/v1/shops/${row?.shop.slug}/availability?date=${row ? chicagoDate(row.startsAt) : ""}`),
  });

  const mutate = (path: string, body?: unknown) => {
    setError("");
    void api(`/api/v1/appointments/${code}/${path}`, session?.token, { method: "POST", body: body ? JSON.stringify(body) : undefined })
      .then(() => visit.refetch())
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      {visit.isLoading ? <Loading label={t("loading")} /> : null}
      {visit.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {row ? (
        <>
          <Display>{row.shop.name}</Display>
          <Body>{row.items[0]?.name ?? ""}</Body>
          <Body muted>{`${row.barber.displayName} · ${row.customer.firstName}`}</Body>
          <Body>{`${displayDate(row.startsAt)} · ${formatClock(row.startsAt, "en-US")}`}</Body>
          <Body>{formatCents(row.estimateCents)}</Body>
          <Body muted>{row.status}</Body>
          {error ? <Banner tone="bad">{error}</Banner> : null}
          {row.status === "booked" || row.status === "confirmed" ? <Button label={t("pay")} onPress={() => router.push(`/pay/${row.code}`)} /> : null}
          {row.canCancel ? <Button label={t("cancelVisit")} kind="danger" onPress={() => mutate("cancel")} /> : null}
          {row.canReschedule ? (
            <>
              <Body>{t("reschedule")}</Body>
              {slots.data?.slots.map((slot) => (
                <Button key={slot.startsAt} kind={when === slot.startsAt ? "primary" : "ghost"} label={formatClock(slot.startsAt, "en-US")} onPress={() => setWhen(slot.startsAt)} />
              ))}
              <Button label={t("reschedule")} disabled={!when} onPress={() => mutate("reschedule", { startsAt: when })} />
            </>
          ) : null}
          {row.status === "completed" ? <Button label={t("bookAgain")} onPress={() => router.push(`/rebook?code=${row.code}`)} /> : null}
        </>
      ) : null}
    </ScrollScreen>
  );
}
