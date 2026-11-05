import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Banner, Body, Button, Card, Display, Field, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";

interface Member { id: string; firstName: string; birthYear: number | null }

export default function Family() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [name, setName] = useState("");
  const [year, setYear] = useState("");
  const [error, setError] = useState("");
  const family = useQuery({
    queryKey: ["family", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ members: Member[] }>("/api/v1/me/family", session?.token),
  });

  const add = () => {
    if (!session || !name.trim()) return;
    setError("");
    void api("/api/v1/me/family", session.token, { method: "POST", body: JSON.stringify({ firstName: name.trim(), birthYear: year ? Number(year) : undefined }) })
      .then(() => { setName(""); setYear(""); return family.refetch(); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
  };
  const remove = (id: string) => {
    if (!session) return;
    void api(`/api/v1/me/family/${id}`, session.token, { method: "DELETE" }).then(() => family.refetch());
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("family")}</Display>
      {family.data?.members.map((member) => (
        <Card key={member.id}>
          <Body>{member.firstName}</Body>
          {member.birthYear ? <Body muted>{String(member.birthYear)}</Body> : null}
          <Button label={t("remove")} kind="ghost" onPress={() => remove(member.id)} />
        </Card>
      ))}
      <Field label={t("firstName")} value={name} onChangeText={setName} />
      <Field label={t("birthYear")} value={year} onChangeText={setYear} keyboardType="number-pad" />
      {error ? <Banner tone="bad">{error}</Banner> : null}
      <Button label={t("add")} onPress={add} />
    </ScrollScreen>
  );
}
