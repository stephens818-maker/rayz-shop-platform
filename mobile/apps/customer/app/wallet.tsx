import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Body, Button, Card, Display, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { TestCardPicker } from "../src/secure-card";
import { useSession } from "../src/session";

interface Method { id: string; brand: string; last4: string; funding: string; wallet: boolean; expMonth: number; expYear: number }

export default function Wallet() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const cards = useQuery({
    queryKey: ["cards", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ paymentMethods: Method[] }>("/api/v1/me/payment-methods", session?.token),
  });

  const remove = (id: string) => {
    if (!session) return;
    void api(`/api/v1/me/payment-methods/${id}`, session.token, { method: "DELETE" }).then(() => cards.refetch());
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("wallet")}</Display>
      <Body muted>{t("addTestCard")}</Body>
      {session ? <TestCardPicker token={session.token} onAdded={() => cards.refetch()} /> : <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />}
      {cards.data?.paymentMethods.map((card) => (
        <Card key={card.id}>
          <Body>{`${card.brand} ••${card.last4}`}</Body>
          <Body muted>{`${card.funding}${card.wallet ? " · wallet" : ""} · ${card.expMonth}/${card.expYear}`}</Body>
          <Button label={t("remove")} kind="ghost" onPress={() => remove(card.id)} />
        </Card>
      ))}
    </ScrollScreen>
  );
}
