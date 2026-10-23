import { formatClock } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Banner, Body, Button, Display, Empty, Loading, ScrollScreen, Title, useI18n } from "@rayz/ui";
import { displayDate } from "../../src/civil-date";
import { api } from "../../src/net";
import { useSession } from "../../src/session";

interface Card {
  appointment: { code: string; status: string; startsAt: string; shop: { name: string }; barber: { displayName: string }; items: { name: string }[] };
}

export default function Visits() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const list = useQuery({
    queryKey: ["visits", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ upcoming: Card[]; past: Card[] }>("/api/v1/me/appointments", session?.token),
  });

  if (!session) {
    return (
      <ScrollScreen>
        <Display>{t("visits")}</Display>
        <Empty title={t("emptyVisits")} body={t("guestConfirm")} />
        <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />
      </ScrollScreen>
    );
  }

  const render = (row: Card) => {
    const a = row.appointment;
    return (
      <Pressable key={a.code} accessibilityRole="button" onPress={() => router.push(`/visit/${a.code}`)} style={{ minHeight: 72, borderRadius: 18, backgroundColor: "#FFFBF6", borderWidth: 1, borderColor: "#E4D7C6", justifyContent: "center", paddingHorizontal: 16 }}>
        <Text style={{ fontSize: 17, fontWeight: "700" }}>{a.shop.name}</Text>
        <Body muted>{`${displayDate(a.startsAt)} · ${formatClock(a.startsAt, "en-US")} · ${a.barber.displayName}`}</Body>
      </Pressable>
    );
  };

  return (
    <ScrollScreen>
      <Display>{t("visits")}</Display>
      {list.isLoading ? <Loading label={t("loading")} /> : null}
      {list.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {list.isError ? <Button label={t("retry")} kind="secondary" onPress={() => list.refetch()} /> : null}
      <Title>{t("upcoming")}</Title>
      <View style={{ gap: 10 }}>{list.data?.upcoming.map(render)}</View>
      {list.data && list.data.upcoming.length === 0 ? <Empty title={t("emptyVisits")} body={t("book")} /> : null}
      <Title>{t("past")}</Title>
      <View style={{ gap: 10 }}>{list.data?.past.map(render)}</View>
    </ScrollScreen>
  );
}
