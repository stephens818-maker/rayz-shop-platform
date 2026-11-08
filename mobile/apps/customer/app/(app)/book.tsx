import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Banner, Body, Display, Empty, Field, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../../src/net";

interface Shop {
  slug: string;
  name: string;
  city: string;
  bookingMode: "native" | "external" | "closed";
}

export default function Book() {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  const shops = useQuery({ queryKey: ["shops"], queryFn: () => api<{ shops: Shop[] }>("/api/v1/shops") });
  const list = (shops.data?.shops ?? []).filter((shop) => shop.name.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <ScrollScreen>
      <Display>{t("shops")}</Display>
      <Field label={t("shops")} value={q} onChangeText={setQ} autoCapitalize="words" />
      {shops.isLoading ? <Loading label={t("loading")} /> : null}
      {shops.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {!shops.isLoading && list.length === 0 ? <Empty title={t("emptyShops")} body={t("browseShops")} /> : null}
      <View style={{ gap: 10 }}>
        {list.map((shop) => (
          <Pressable key={shop.slug} accessibilityRole="button" onPress={() => router.push(`/shop/${shop.slug}`)} style={{ minHeight: 72, borderRadius: 18, backgroundColor: "#FFFBF6", borderWidth: 1, borderColor: "#E4D7C6", justifyContent: "center", paddingHorizontal: 16 }}>
            <Text style={{ fontSize: 18, fontWeight: "700", color: "#1C1612" }}>{shop.name}</Text>
            <Body muted>{shop.bookingMode === "native" ? shop.city : t("notLive")}</Body>
          </Pressable>
        ))}
      </View>
    </ScrollScreen>
  );
}
