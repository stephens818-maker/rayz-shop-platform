import { formatCents, formatClock } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Banner, Body, Button, Card, Display, Empty, Loading, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../../src/net";
import { useSession } from "../../src/session";

interface HomePayload {
  nextAppointment: { appointment: { code: string; startsAt: string; shop: { name: string }; barber: { displayName: string }; items: { name: string }[] } } | null;
  rebook: { code: string; barberName: string; serviceName: string; weeks: number } | null;
  loyalty: { progressCents: number; thresholdCents: number; availableCents: number; badge: { label: string; reason: string } };
  favoriteShop: { name: string; waitMinutes: number };
}

export default function Home() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const home = useQuery({
    queryKey: ["home", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<HomePayload>("/api/v1/me/home", session?.token),
  });

  if (!session) {
    return (
      <ScrollScreen>
        <Display>{t("appName")}</Display>
        <Body muted>{t("welcomeBody")}</Body>
        <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />
        <Button label={t("browseShops")} kind="secondary" onPress={() => router.push("/(app)/book")} />
      </ScrollScreen>
    );
  }

  const next = home.data?.nextAppointment?.appointment;
  return (
    <ScrollScreen>
      <Display>{session.firstName}</Display>
      <Body muted>{home.data ? `${home.data.favoriteShop.name} · ${home.data.favoriteShop.waitMinutes} min` : t("loading")}</Body>
      {home.isLoading ? <Loading label={t("loading")} /> : null}
      {home.isError ? <Banner tone="bad">{home.error instanceof Error ? home.error.message : t("retry")}</Banner> : null}
      {home.isError ? <Button label={t("retry")} kind="secondary" onPress={() => home.refetch()} /> : null}
      {next ? (
        <Card>
          <Body muted>{t("nextVisit")}</Body>
          <Body>{next.shop.name}</Body>
          <Body>{`${next.barber.displayName} · ${next.items[0]?.name ?? ""}`}</Body>
          <Body>{`${formatClock(next.startsAt, "en-US")}`}</Body>
          <Button label={t("pay")} onPress={() => router.push(`/pay/${next.code}`)} />
          <Button label={t("visits")} kind="ghost" onPress={() => router.push(`/visit/${next.code}`)} />
        </Card>
      ) : home.data ? (
        <Empty title={t("emptyVisits")} body={t("welcomeBody")} />
      ) : null}
      {home.data?.rebook ? (
        <Card>
          <Body>{`${t("bookAgain")} · ${home.data.rebook.barberName}`}</Body>
          <Body muted>{home.data.rebook.serviceName}</Body>
          <Button label={t("bookAgain")} onPress={() => router.push(`/rebook?code=${home.data?.rebook?.code}`)} />
        </Card>
      ) : null}
      {home.data ? (
        <Card>
          <Body muted>{t("loyaltyTitle")}</Body>
          <Body>{home.data.loyalty.badge.label}</Body>
          <Body muted>{home.data.loyalty.badge.reason}</Body>
          <Money cents={home.data.loyalty.availableCents} />
          <Body muted>{`${t("availableReward")} · ${formatCents(home.data.loyalty.progressCents)} / ${formatCents(home.data.loyalty.thresholdCents)}`}</Body>
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
