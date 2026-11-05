import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Banner, Body, Button, Display, Field, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";
import { signOutSession } from "../src/sign-out";

export default function DeleteAccount() {
  const { t } = useI18n();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, clear } = useSession();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const start = useQuery({
    queryKey: ["delete", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ consequences: string[]; devCode?: string }>("/api/v1/me/delete/start", session?.token, { method: "POST" }),
  });

  const confirm = () => {
    if (!session) return;
    setError("");
    void api("/api/v1/me/delete/confirm", session.token, { method: "POST", body: JSON.stringify({ code }) })
      .then(async () => {
        await signOutSession(queryClient, clear);
        router.replace("/welcome");
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("deleteAccount")}</Display>
      <Body>{t("beforeDelete")}</Body>
      {start.data?.consequences.map((line) => <Body key={line} muted>{line}</Body>)}
      <Body muted>{t("deleteCodeHint")}</Body>
      {start.data?.devCode ? <Banner>{start.data.devCode}</Banner> : null}
      <Field label={t("codeTitle")} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Button label={t("confirmDelete")} kind="danger" onPress={confirm} />
    </ScrollScreen>
  );
}
