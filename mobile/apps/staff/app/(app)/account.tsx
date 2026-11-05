import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Body, Button, Display, ScrollScreen, useI18n } from "@rayz/ui";
import { API_URL } from "../../src/net";
import { useStaff } from "../../src/session";
import { signOutSession } from "../../src/sign-out";

export default function Account() {
  const { t, lang, setLang } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, clear } = useStaff();

  const register = () => {
    if (!session) return;
    void fetch(`${API_URL}/api/staff/v1/me/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ token: "sandbox-staff", reminders: true, marketing: false }),
    });
  };

  return (
    <ScrollScreen>
      <Display>{session?.firstName ?? t("account")}</Display>
      <Body muted>{t("marketingHint")}</Body>
      <Button label={t("reminders")} kind="secondary" onPress={register} />
      <Button label={lang === "en" ? t("spanish") : t("english")} kind="ghost" onPress={() => setLang(lang === "en" ? "es" : "en")} />
      <Button
        label={t("signOut")}
        kind="ghost"
        onPress={() => {
          void signOutSession(queryClient, clear).then(() => router.replace("/sign-in"));
        }}
      />
    </ScrollScreen>
  );
}
