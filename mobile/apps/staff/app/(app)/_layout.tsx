import { Tabs, Redirect } from "expo-router";
import { useState } from "react";
import { Body, Button, Display, Screen, useI18n } from "@rayz/ui";
import { useStaff } from "../../src/session";
import { unlockApp } from "../../src/unlock";

function Unlock() {
  const { t } = useI18n();
  const { setUnlocked } = useStaff();
  const [error, setError] = useState("");
  return (
    <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
      <Display>{t("unlockTitle")}</Display>
      <Body>{t("unlockBody")}</Body>
      <Button
        label={t("unlock")}
        onPress={() => {
          void unlockApp().then((ok) => (ok ? setUnlocked(true) : setError(t("retry"))));
        }}
      />
      {error ? <Body>{error}</Body> : null}
    </Screen>
  );
}

export default function StaffTabs() {
  const { t } = useI18n();
  const { session, ready, unlocked } = useStaff();
  if (!ready) return null;
  if (!session) return <Redirect href="/sign-in" />;
  if (!unlocked) return <Unlock />;
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
      <Tabs.Screen name="today" options={{ title: t("today") }} />
      <Tabs.Screen name="clock" options={{ title: t("clockIn") }} />
      <Tabs.Screen name="earnings" options={{ title: t("earnings") }} />
      <Tabs.Screen name="payouts" options={{ title: t("payouts") }} />
      <Tabs.Screen name="account" options={{ title: t("account") }} />
    </Tabs>
  );
}
