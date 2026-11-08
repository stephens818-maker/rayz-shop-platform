import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Banner, Body, Button, Display, Field, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";

interface Me { firstName: string; email: string | null; phone: string; smsOptIn: boolean }

export default function Profile() {
  const { t } = useI18n();
  const router = useRouter();
  const { session, save } = useSession();
  const [name, setName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const me = useQuery({
    queryKey: ["me", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<Me>("/api/v1/me", session?.token),
  });
  const first = name ?? me.data?.firstName ?? "";
  const mail = email ?? me.data?.email ?? "";

  const submit = () => {
    if (!session) return;
    setError("");
    void api<Me>("/api/v1/me", session.token, { method: "PATCH", body: JSON.stringify({ firstName: first, email: mail || null }) })
      .then(async (body) => {
        await save({ ...session, firstName: body.firstName });
        setSaved(true);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("profile")}</Display>
      {me.data ? <Body muted>{me.data.phone}</Body> : null}
      <Field label={t("firstName")} value={first} onChangeText={setName} />
      <Field label="Email" value={mail} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      {saved ? <Body>{t("done")}</Body> : null}
      <Button label={t("save")} onPress={submit} />
    </ScrollScreen>
  );
}
