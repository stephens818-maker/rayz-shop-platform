import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Linking } from "react-native";
import { Banner, Body, Button, Card, Display, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../../src/net";

interface Shop {
  id: string;
  slug: string;
  name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  description: string;
  bookingMode: "native" | "external" | "closed";
  externalBookingUrl: string | null;
  lat: number;
  lng: number;
  hours: { weekday: number; open: string; close: string }[];
  payments: boolean;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function clock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

export default function ShopDetail() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const shop = useQuery({ queryKey: ["shop", slug], queryFn: () => api<Shop>(`/api/v1/shops/${slug}`) });
  const live = useQuery({ queryKey: ["live", slug], queryFn: () => api<{ waitMinutes: number; chairsFree: number }>(`/api/v1/shops/${slug}/live`) });
  const row = shop.data;

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      {shop.isLoading ? <Loading label={t("loading")} /> : null}
      {shop.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {row ? (
        <>
          <Display>{row.name}</Display>
          <Body>{row.description}</Body>
          <Body muted>{`${row.address}, ${row.city}, ${row.state} ${row.zip}`}</Body>
          {live.data ? <Body muted>{`${t("wait")}: ${live.data.waitMinutes} min · ${t("chairsOpen")}: ${live.data.chairsFree}`}</Body> : null}
          <Card>
            <Body>{t("hours")}</Body>
            {row.hours.map((hour) => (
              <Body key={hour.weekday} muted>{`${DAYS[hour.weekday]}  ${clock(hour.open)} – ${clock(hour.close)}`}</Body>
            ))}
          </Card>
          <Button label={t("call")} kind="secondary" onPress={() => Linking.openURL(`tel:${row.phone}`)} />
          <Button label={t("directions")} kind="secondary" onPress={() => Linking.openURL(`https://maps.google.com/?daddr=${row.lat},${row.lng}`)} />
          {row.bookingMode === "native" ? (
            <Button label={t("book")} onPress={() => router.push(`/book-visit?slug=${row.slug}`)} />
          ) : (
            <>
              <Banner>{t("notLive")}</Banner>
              {row.externalBookingUrl ? <Button label={t("bookOnWeb")} onPress={() => Linking.openURL(row.externalBookingUrl!)} /> : null}
            </>
          )}
        </>
      ) : null}
    </ScrollScreen>
  );
}
