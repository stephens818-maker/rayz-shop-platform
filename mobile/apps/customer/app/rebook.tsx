import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Banner, Body, Button, Display, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";

export default function Rebook() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [error, setError] = useState("");
  const visit = useQuery({
    queryKey: ["rebook", code],
    queryFn: () => api<{ appointment: { shop: { name: string }; barber: { displayName: string }; items: { name: string }[] } }>(`/api/v1/appointments/${code}`, session?.token),
  });
  const row = visit.data?.appointment;

  const confirm = () => {
    if (!session) {
      router.push("/sign-in");
      return;
    }
    setError("");
    void api<{ appointment: { code: string } }>(`/api/v1/appointments/${code}/rebook`, session.token, { method: "POST" })
      .then((body) => router.replace(`/visit/${body.appointment.code}`))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("bookAgain")}</Display>
      {visit.isLoading ? <Loading label={t("loading")} /> : null}
      {row ? (
        <>
          <Body>{row.shop.name}</Body>
          <Body>{row.barber.displayName}</Body>
          <Body muted>{row.items[0]?.name ?? ""}</Body>
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <Button label={t("confirm")} onPress={confirm} />
        </>
      ) : null}
    </ScrollScreen>
  );
}
