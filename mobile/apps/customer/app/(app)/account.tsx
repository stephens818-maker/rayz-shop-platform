import { useRouter } from "expo-router";
import { Button, Display, ScrollScreen, useI18n } from "@rayz/ui";
import { useSession } from "../../src/session";

export default function Account() {
  const { t, lang, setLang } = useI18n();
  const router = useRouter();
  const { session, clear } = useSession();

  if (!session) {
    return (
      <ScrollScreen>
        <Display>{t("account")}</Display>
        <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />
        <Button label={lang === "en" ? t("spanish") : t("english")} kind="ghost" onPress={() => setLang(lang === "en" ? "es" : "en")} />
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen>
      <Display>{session.firstName}</Display>
      <Button label={t("profile")} kind="secondary" onPress={() => router.push("/profile")} />
      <Button label={t("family")} kind="secondary" onPress={() => router.push("/family")} />
      <Button label={t("wallet")} kind="secondary" onPress={() => router.push("/wallet")} />
      <Button label={t("receipts")} kind="secondary" onPress={() => router.push("/receipts")} />
      <Button label={t("notifications")} kind="secondary" onPress={() => router.push("/notifications")} />
      <Button label={lang === "en" ? t("spanish") : t("english")} kind="ghost" onPress={() => setLang(lang === "en" ? "es" : "en")} />
      <Button label={t("signOut")} kind="ghost" onPress={() => { void clear().then(() => router.replace("/welcome")); }} />
      <Button label={t("deleteAccount")} kind="danger" onPress={() => router.push("/delete-account")} />
    </ScrollScreen>
  );
}
