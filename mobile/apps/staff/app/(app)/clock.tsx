import type { StaffConfig } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { Banner, Body, Button, Chip, Display, Field, ScrollScreen, useI18n } from "@rayz/ui";
import { shopForClock } from "../../src/clock-shop";
import { NativeCamera } from "../../src/native-camera";
import { API_URL } from "../../src/net";
import { useStaff } from "../../src/session";

export default function Clock() {
  const { t } = useI18n();
  const { session } = useStaff();
  const [cash, setCash] = useState("");
  const [attest, setAttest] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const me = useQuery({
    queryKey: ["staff-me", session?.token],
    enabled: Boolean(session),
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/me`, { headers: { authorization: `Bearer ${session?.token}` } });
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as { shops: string[] };
    },
  });
  const config = useQuery({
    queryKey: ["staff-config"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/config`);
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as StaffConfig;
    },
  });
  const shops = me.data?.shops ?? [];
  const shopId = shopForClock(shops, picked);
  const labelFor = (id: string) => config.data?.shops.find((shop) => shop.shopId === id)?.slug ?? id;

  const punch = async (direction: "in" | "out", token: string) => {
    setError("");
    const cents = Math.max(0, Math.round(Number(cash || "0") * 100));
    const payload = direction === "in" ? { token } : { token, cashTipCents: cents, attestation: attest };
    const res = await fetch(`${API_URL}/api/staff/v1/clock/${direction}`, {
      method: "POST",
      headers: { authorization: `Bearer ${session?.token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as { error?: { message: string } };
    if (!res.ok) {
      setError(body.error?.message ?? t("retry"));
      return;
    }
    setMessage(direction === "in" ? t("clockedIn") : t("clockedOut"));
  };

  return (
    <ScrollScreen>
      <Display>{t("clockIn")}</Display>
      <Body muted>{t("unlockBody")}</Body>
      {shops.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {shops.map((id) => (
            <Chip key={id} label={labelFor(id)} selected={picked === id} onPress={() => setPicked(id)} />
          ))}
        </View>
      ) : null}
      {shops.length > 1 && !shopId ? <Body>{t("pickShop")}</Body> : null}
      <NativeCamera
        onToken={(token) => {
          void punch("in", token);
        }}
      />
      <Field label={t("shopCode")} value={code} onChangeText={setCode} autoCapitalize="none" />
      <Body muted>{t("shopCodeHint")}</Body>
      <Button
        label={t("clockIn")}
        onPress={() => {
          if (!code.trim()) {
            setError(t("shopCodeHint"));
            return;
          }
          void punch("in", code.trim());
        }}
      />
      <Field label={t("cashToday")} value={cash} onChangeText={setCash} keyboardType="decimal-pad" />
      <Button label={attest ? `${t("attestCash")} ✓` : t("attestCash")} kind={attest ? "primary" : "ghost"} onPress={() => setAttest((value) => !value)} />
      <Button
        label={t("clockOut")}
        kind="secondary"
        onPress={() => {
          if (!code.trim()) {
            setError(t("shopCodeHint"));
            return;
          }
          void punch("out", code.trim());
        }}
      />
      {message ? <Banner tone="good">{message}</Banner> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
    </ScrollScreen>
  );
}
