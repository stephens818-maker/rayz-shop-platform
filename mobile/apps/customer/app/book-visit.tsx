import { formatCents, formatClock, formatLongDate, localeFor } from "@rayz/api";
import { displayDate } from "../src/civil-date";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Chip, Display, Field, Loading, ScrollScreen, useI18n } from "@rayz/ui";
import { peekDraft, setDraft } from "../src/draft";
import { api } from "../src/net";
import { useSession } from "../src/session";

interface Shop { id: string; slug: string; name: string; bookingMode: string }
interface Service { id: string; name: string; priceCents: number; durationMin: number }
interface Barber { id: string; displayName: string }
interface Slot { startsAt: string; barberIds: string[] }
interface Member { id: string; firstName: string }

export default function BookVisit() {
  const { slug, resume } = useLocalSearchParams<{ slug: string; resume?: string }>();
  const { t, lang } = useI18n();
  const locale = localeFor(lang);
  const router = useRouter();
  const { session } = useSession();
  const saved = resume ? peekDraft() : null;
  const [step, setStep] = useState<"service" | "barber" | "time" | "confirm">(saved ? "confirm" : "service");
  const [service, setService] = useState<Service | null>(saved ? { id: saved.serviceId, name: saved.serviceName, priceCents: saved.priceCents, durationMin: 40 } : null);
  const [barber, setBarber] = useState<{ id: string | null; name: string }>(saved ? { id: saved.barberId, name: saved.barberName } : { id: null, name: "" });
  const [day, setDay] = useState("");
  const [slot, setSlot] = useState(saved?.startsAt ?? "");
  const [notes, setNotes] = useState(saved?.notes ?? "");
  const [forId, setForId] = useState<string | null>(saved?.forCustomerId ?? null);
  const [forName, setForName] = useState(saved?.forName ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const shop = useQuery({ queryKey: ["shop", slug], queryFn: () => api<Shop>(`/api/v1/shops/${slug}`) });
  const services = useQuery({ queryKey: ["services", slug], queryFn: () => api<{ services: Service[] }>(`/api/v1/shops/${slug}/services`) });
  const barbers = useQuery({ queryKey: ["barbers", slug], queryFn: () => api<{ barbers: Barber[] }>(`/api/v1/shops/${slug}/barbers`) });
  const days = useQuery({ queryKey: ["days", slug], queryFn: () => api<{ days: { date: string; slots: number }[] }>(`/api/v1/shops/${slug}/available-days`) });
  const family = useQuery({
    queryKey: ["family", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<{ members: Member[] }>("/api/v1/me/family", session?.token),
  });
  const slots = useQuery({
    queryKey: ["slots", slug, day, service?.id, barber.id],
    enabled: Boolean(day),
    queryFn: () => api<{ slots: Slot[] }>(`/api/v1/shops/${slug}/availability?date=${day}&serviceId=${service?.id ?? ""}&barberId=${barber.id ?? ""}`),
  });

  useEffect(() => {
    if (!day && days.data?.days[0]) setDay(days.data.days[0].date);
  }, [day, days.data]);

  const confirm = () => {
    if (!shop.data || !service || !slot) return;
    const draft = {
      slug: shop.data.slug,
      shopId: shop.data.id,
      shopName: shop.data.name,
      serviceId: service.id,
      serviceName: service.name,
      priceCents: service.priceCents,
      barberId: barber.id,
      barberName: barber.name || t("anyBarber"),
      startsAt: slot,
      notes,
      forCustomerId: forId,
      forName: forName || t("me"),
    };
    if (!session) {
      setDraft(draft);
      router.push("/sign-in");
      return;
    }
    setBusy(true);
    setError("");
    void api<{ appointment: { code: string } }>("/api/v1/appointments", session.token, {
      method: "POST",
      headers: { "Idempotency-Key": `book-${draft.shopId}-${draft.startsAt}-${draft.serviceId}` },
      body: JSON.stringify({ shopId: draft.shopId, serviceId: draft.serviceId, barberId: draft.barberId ?? undefined, startsAt: draft.startsAt, notes: draft.notes, customerId: draft.forCustomerId ?? undefined }),
    })
      .then((body) => {
        setDraft(null);
        router.replace(`/visit/${body.appointment.code}`);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")))
      .finally(() => setBusy(false));
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{shop.data?.name ?? t("book")}</Display>
      {shop.data && shop.data.bookingMode !== "native" ? <Banner>{t("notLive")}</Banner> : null}
      {step === "service" ? (
        <>
          <Body>{t("services")}</Body>
          {services.isLoading ? <Loading label={t("loading")} /> : null}
          {services.data?.services.map((item) => (
            <Button key={item.id} kind="secondary" label={`${item.name} · ${formatCents(item.priceCents)}`} onPress={() => { setService(item); setStep("barber"); }} />
          ))}
        </>
      ) : null}
      {step === "barber" ? (
        <>
          <Body>{t("barber")}</Body>
          <Button label={t("anyBarber")} kind="secondary" onPress={() => { setBarber({ id: null, name: t("anyBarber") }); setStep("time"); }} />
          {barbers.data?.barbers.map((item) => (
            <Button key={item.id} kind="secondary" label={item.displayName} onPress={() => { setBarber({ id: item.id, name: item.displayName }); setStep("time"); }} />
          ))}
        </>
      ) : null}
      {step === "time" ? (
        <>
          <Body>{t("selectTime")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {days.data?.days.filter((item) => item.slots > 0).slice(0, 7).map((item) => (
              <Chip key={item.date} label={formatLongDate(item.date, locale)} selected={item.date === day} onPress={() => { setDay(item.date); setSlot(""); }} />
            ))}
          </View>
          {slots.isLoading ? <Loading label={t("loading")} /> : null}
          {slots.data?.slots.map((item) => (
            <Button key={item.startsAt} kind={item.startsAt === slot ? "primary" : "secondary"} label={formatClock(item.startsAt, locale)} onPress={() => { setSlot(item.startsAt); setStep("confirm"); }} />
          ))}
        </>
      ) : null}
      {step === "confirm" && service ? (
        <>
          <Body>{service.name}</Body>
          <Body muted>{barber.name || t("anyBarber")}</Body>
          {slot ? <Body>{`${displayDate(slot, locale)} · ${formatClock(slot, locale)}`}</Body> : null}
          <Body>{formatCents(service.priceCents)}</Body>
          <Body>{t("forWhom")}</Body>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label={t("me")} selected={!forId} onPress={() => { setForId(null); setForName(t("me")); }} />
            {family.data?.members.map((member) => (
              <Chip key={member.id} label={member.firstName} selected={forId === member.id} onPress={() => { setForId(member.id); setForName(member.firstName); }} />
            ))}
          </View>
          <Field label={t("notes")} value={notes} onChangeText={setNotes} />
          {error ? <Banner tone="bad">{error}</Banner> : null}
          <Button label={session ? t("bookThis") : t("guestConfirm")} disabled={busy || !slot} onPress={confirm} />
        </>
      ) : null}
    </ScrollScreen>
  );
}
