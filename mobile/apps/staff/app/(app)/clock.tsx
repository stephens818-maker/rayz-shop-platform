import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Banner, Body, Button, Display, Field, ScrollScreen, useI18n } from "@rayz/ui";
import { NativeCamera } from "../../src/native-camera";
import { API_URL } from "../../src/net";
import { useStaff } from "../../src/session";

interface Qr {
  token: string;
  error?: { message: string };
}

export default function Clock() {
  const { t } = useI18n();
  const { session } = useStaff();
  const [cash, setCash] = useState("");
  const [attest, setAttest] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const me = useQuery({
    queryKey: ["staff-me", session?.token],
    enabled: Boolean(session),
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/me`, { headers: { authorization: `Bearer ${session?.token}` } });
      if (!res.ok) throw new Error(t("retry"));
      return (await res.json()) as { shops: string[] };
    },
  });

  const currentCode = async () => {
    const shopId = me.data?.shops[0];
    if (!shopId) throw new Error(t("retry"));
    const res = await fetch(`${API_URL}/api/staff/v1/kiosk/qr?shopId=${shopId}`);
    const body = (await res.json()) as Qr;
    if (!res.ok || !body.token) throw new Error(body.error?.message ?? t("retry"));
    return body.token;
  };

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
      <NativeCamera
        onToken={(token) => {
          void punch("in", token);
        }}
      />
      <Button
        label={t("clockIn")}
        onPress={() => {
          void currentCode().then((token) => punch("in", token)).catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
        }}
      />
      <Field label={t("cashToday")} value={cash} onChangeText={setCash} keyboardType="decimal-pad" />
      <Button label={attest ? `${t("attestCash")} ✓` : t("attestCash")} kind={attest ? "primary" : "ghost"} onPress={() => setAttest((value) => !value)} />
      <Button
        label={t("clockOut")}
        kind="secondary"
        onPress={() => {
          void currentCode().then((token) => punch("out", token)).catch((err: unknown) => setError(err instanceof Error ? err.message : t("retry")));
        }}
      />
      {message ? <Banner tone="good">{message}</Banner> : null}
      {error ? <Banner tone="bad">{error}</Banner> : null}
    </ScrollScreen>
  );
}
