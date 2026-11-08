import { useRouter } from "expo-router";
import { Text } from "react-native";
import { Button, Screen, useI18n } from "@rayz/ui";

export default function Welcome() {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
      <Text style={{ fontSize: 13, letterSpacing: 4, fontWeight: "700", color: "#8A6830" }}>RAY'Z</Text>
      <Text accessibilityRole="header" style={{ fontSize: 42, lineHeight: 48, fontWeight: "700", color: "#1C1612" }}>{t("welcomeTitle")}</Text>
      <Text style={{ fontSize: 18, lineHeight: 26, color: "#4E453C" }}>{t("welcomeBody")}</Text>
      <Button label={t("continue")} onPress={() => router.push("/sign-in")} />
      <Button label={t("browseShops")} kind="secondary" onPress={() => router.push("/(app)/book")} />
      <Text style={{ color: "#4E453C" }}>{t("sandboxHint")}</Text>
    </Screen>
  );
}
