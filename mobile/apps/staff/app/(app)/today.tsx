import { formatClock, localeFor } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Banner, Body, Button, Display, Empty, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { API_URL } from "../../src/net";
import { useStaff } from "../../src/session";

interface Row {
  id: string;
  startsAt: string;
  clientId: string;
  clientFirstName: string;
  serviceName: string;
  status: string;
}

const NEXT: Record<string, { status: string; label: "checkedIn" | "inChair" | "finished" | "noShow" }[]> = {
  booked: [
    { status: "checked_in", label: "checkedIn" },
    { status: "no_show", label: "noShow" },
  ],
  confirmed: [
    { status: "checked_in", label: "checkedIn" },
    { status: "no_show", label: "noShow" },
  ],
  checked_in: [{ status: "in_service", label: "inChair" }],
  in_service: [{ status: "completed", label: "finished" }],
};

export default function Today() {
  const { t, lang } = useI18n();
  const locale = localeFor(lang);
  const router = useRouter();
  const { session } = useStaff();
  const me = useQuery({
    queryKey: ["staff-me", session?.token],
    enabled: Boolean(session),
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/me`, { headers: { authorization: `Bearer ${session?.token}` } });
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as { firstName: string; shops: string[] };
    },
  });
  const shopId = me.data?.shops[0];
  const calendar = useQuery({
    queryKey: ["calendar", session?.token, shopId],
    enabled: Boolean(session && shopId),
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/me/calendar?shopId=${shopId}`, { headers: { authorization: `Bearer ${session?.token}` } });
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as { appointments: Row[] };
    },
  });

  const setStatus = (id: string, status: string) => {
    void fetch(`${API_URL}/api/staff/v1/appointments/${id}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${session?.token}`, "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }).then(() => calendar.refetch());
  };

  return (
    <ScrollScreen>
      <Display>{me.data?.firstName ?? t("today")}</Display>
      <Body muted>{t("today")}</Body>
      {calendar.isLoading ? <Loading label={t("loading")} /> : null}
      {calendar.isError ? <Banner tone="bad">{t("retry")}</Banner> : null}
      {calendar.data && calendar.data.appointments.length === 0 ? <Empty title={t("noAppointments")} body={t("today")} /> : null}
      {calendar.data?.appointments.map((row) => (
        <View key={row.id} style={{ gap: 8, backgroundColor: "#FFFBF6", borderRadius: 18, borderWidth: 1, borderColor: "#E4D7C6", padding: 16 }}>
          <Pressable accessibilityRole="button" onPress={() => router.push(`/client/${row.clientId}`)}>
            <Text style={{ fontSize: 18, fontWeight: "700" }}>{row.clientFirstName}</Text>
            <Body muted>{`${formatClock(row.startsAt, locale)} · ${row.serviceName}`}</Body>
          </Pressable>
          <Body muted>{row.status}</Body>
          {(NEXT[row.status] ?? []).map((action) => (
            <Button key={action.status} kind="secondary" label={t(action.label)} onPress={() => setStatus(row.id, action.status)} />
          ))}
        </View>
      ))}
    </ScrollScreen>
  );
}
