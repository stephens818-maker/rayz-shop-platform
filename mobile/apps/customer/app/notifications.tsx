import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Platform } from "react-native";
import { Body, Button, Display, ScrollScreen, useI18n } from "@rayz/ui";
import { api } from "../src/net";
import { useSession } from "../src/session";
import { CONSENT_TEXT_VERSION, smsPatch, smsToggle } from "../src/sms";

interface Me {
  pushTransactional: boolean;
  pushMarketing: boolean;
  smsOptIn: boolean;
  smsMarketingOptIn: boolean;
}

export default function Notifications() {
  const { t } = useI18n();
  const router = useRouter();
  const { session } = useSession();
  const [saved, setSaved] = useState("");
  const me = useQuery({
    queryKey: ["me", session?.token],
    enabled: Boolean(session),
    queryFn: () => api<Me>("/api/v1/me", session?.token),
  });
  const [reminders, setReminders] = useState<boolean | null>(null);
  const [marketing, setMarketing] = useState<boolean | null>(null);
  const [texts, setTexts] = useState<boolean | null>(null);
  const [smsTurnedOff, setSmsTurnedOff] = useState(false);
  const reminderOn = reminders ?? me.data?.pushTransactional ?? true;
  const marketingOn = marketing ?? me.data?.pushMarketing ?? false;
  const textOffers = texts ?? me.data?.smsMarketingOptIn ?? false;
  const sms = smsToggle(Boolean(me.data?.smsOptIn) && !smsTurnedOff);

  const save = () => {
    if (!session || !me.data) return;
    const patch = smsPatch(me.data.smsOptIn, { smsMarketingOptIn: textOffers, turnSmsOff: smsTurnedOff || !sms.on });
    const consent = reminderOn || marketingOn || textOffers ? { consentTextVersion: patch.consentTextVersion ?? CONSENT_TEXT_VERSION } : {};
    void api("/api/v1/me", session.token, {
      method: "PATCH",
      body: JSON.stringify({ pushTransactional: reminderOn, pushMarketing: marketingOn, ...patch, ...consent }),
    }).then(async () => {
      if (Platform.OS !== "web") {
        const Notifications = await import("expo-notifications");
        const permission = await Notifications.requestPermissionsAsync();
        if (permission.granted) {
          const token = await Notifications.getExpoPushTokenAsync();
          await api("/api/v1/me/devices", session.token, { method: "POST", body: JSON.stringify({ token: token.data, reminders: reminderOn, marketing: marketingOn }) });
        }
      } else {
        await api("/api/v1/me/devices", session.token, { method: "POST", body: JSON.stringify({ token: "web-sandbox", reminders: reminderOn, marketing: marketingOn, platform: "web" }) });
      }
      setSaved(t("done"));
      void me.refetch();
    });
  };

  return (
    <ScrollScreen>
      <Button label={t("back")} kind="ghost" onPress={() => router.back()} />
      <Display>{t("notifications")}</Display>
      <Body muted>{t("marketingHint")}</Body>
      <Body muted>{t("smsCodesSeparate")}</Body>
      <Button label={`${t("reminders")}: ${reminderOn ? "On" : "Off"}`} kind={reminderOn ? "primary" : "secondary"} onPress={() => setReminders(!reminderOn)} />
      <Button label={`${t("marketing")}: ${marketingOn ? "On" : "Off"}`} kind={marketingOn ? "primary" : "ghost"} onPress={() => setMarketing(!marketingOn)} />
      <Button
        label={`${t("smsTexts")}: ${sms.on ? "On" : "Off"}`}
        kind={sms.on ? "primary" : "secondary"}
        disabled={!sms.enabled}
        onPress={() => {
          if (!sms.enabled) return;
          setSmsTurnedOff(true);
        }}
      />
      {sms.note ? <Body>{t("smsOffNote")}</Body> : null}
      <Button label={`${t("smsMarketing")}: ${textOffers ? "On" : "Off"}`} kind={textOffers ? "primary" : "ghost"} onPress={() => setTexts(!textOffers)} />
      <Button label={t("save")} onPress={save} />
      {saved ? <Body>{saved}</Body> : null}
    </ScrollScreen>
  );
}
