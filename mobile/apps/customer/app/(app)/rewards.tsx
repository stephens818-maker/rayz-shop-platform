import { formatCents, formatLongDate } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Banner, Body, Button, Card, Display, Loading, Money, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../../src/net";
import { useSession } from "../../src/session";

interface Loyalty {
  progressCents: number;
  thresholdCents: number;
  rewardCents: number;
  availableCents: number;
  badge?: { label: string };
  rules: { earn: string; redeem: string; expiry: string };
}
interface Ledger {
  entries: { id: string; label: string; amountCents: number; at: string }[];
}

export default function Rewards() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const loyalty = useQuery({
    queryKey: ["loyalty", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<Loyalty>("/api/v1/me/loyalty", session?.token),
  });
  const ledger = useQuery({
    queryKey: ["ledger", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<Ledger>("/api/v1/me/loyalty/ledger", session?.token),
  });

  if (!session) {
    return (
      <ScrollScreen>
        <Display>{t("rewards")}</Display>
        <Button label={t("signIn")} onPress={() => router.push("/sign-in")} />
      </ScrollScreen>
    );
  }

  return (
    <ScrollScreen>
      <Display>{t("rewards")}</Display>
      {loyalty.isLoading ? <Loading label={t("loading")} /> : null}
      {loyalty.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {loyalty.data ? (
        <Card>
          <Body muted>{t("progress")}</Body>
          <Money cents={loyalty.data.availableCents} large />
          <Body>{`${formatCents(loyalty.data.progressCents)} / ${formatCents(loyalty.data.thresholdCents)}`}</Body>
          <Body muted>{loyalty.data.rules.earn}</Body>
          <Body muted>{loyalty.data.rules.redeem}</Body>
          <Body muted>{loyalty.data.rules.expiry}</Body>
        </Card>
      ) : null}
      <Body muted>{t("history")}</Body>
      {ledger.data?.entries.map((entry) => (
        <Card key={entry.id}>
          <Body>{entry.label}</Body>
          <Body muted>{formatLongDate(entry.at.slice(0, 10), "en-US")}</Body>
          <Money cents={entry.amountCents} />
        </Card>
      ))}
    </ScrollScreen>
  );
}
