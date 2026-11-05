import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Body, Button, Card, Display, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { API_URL } from "../../src/net";
import { useStaff } from "../../src/session";

interface ClientCard {
  firstName: string;
}

export default function Client() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useStaff();
  const client = useQuery({
    queryKey: ["client", id, session?.token],
    enabled: Boolean(session && id),
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/clients/${id}`, { headers: { authorization: `Bearer ${session?.token}` } });
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as ClientCard;
    },
  });

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("clientCard")}</Display>
      {client.isLoading ? <Loading label={t("loading")} /> : null}
      {client.data ? (
        <Card>
          <Body>{client.data.firstName}</Body>
        </Card>
      ) : null}
    </ScrollScreen>
  );
}
