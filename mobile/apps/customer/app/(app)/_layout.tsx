import { Tabs } from "expo-router";
import { useI18n } from "@rayz/ui";

export default function TabsLayout() {
  const { t } = useI18n();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: "#1C1612",
        tabBarInactiveTintColor: "#4E453C",
        tabBarStyle: { backgroundColor: "#FFFBF6", borderTopColor: "#E4D7C6", minHeight: 62 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
      }}
    >
      <Tabs.Screen name="home" options={{ title: t("home") }} />
      <Tabs.Screen name="book" options={{ title: t("book") }} />
      <Tabs.Screen name="visits" options={{ title: t("visits") }} />
      <Tabs.Screen name="rewards" options={{ title: t("rewards") }} />
      <Tabs.Screen name="account" options={{ title: t("account") }} />
    </Tabs>
  );
}
