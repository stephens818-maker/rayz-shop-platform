import { bootGate, setTimeFormat, type StaffConfig } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { Body, Button, Display, Screen, useI18n } from "@rayz/ui";
import { API_URL, APP_VERSION } from "./net";

const platform = Platform.OS === "android" ? "android" : "ios";

class StaffApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function loadConfig(): Promise<StaffConfig> {
  const res = await fetch(`${API_URL}/api/staff/v1/config`, { headers: { "x-client": platform, "x-app-version": APP_VERSION } });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new StaffApiError(res.status, body?.error?.message ?? "config");
  return body as StaffConfig;
}

export function ConfigGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const config = useQuery({ queryKey: ["staff-config"], retry: false, queryFn: loadConfig });
  useEffect(() => {
    if (config.data?.timeFormat) setTimeFormat(config.data.timeFormat);
  }, [config.data?.timeFormat]);
  if (config.isPending) {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Body>{t("loading")}</Body>
      </Screen>
    );
  }
  const status = config.error instanceof StaffApiError ? config.error.status : undefined;
  const gate = config.isSuccess ? bootGate(config.data, APP_VERSION, platform) : bootGate(null, APP_VERSION, platform, status);
  if (gate === "update") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("updateRequired")}</Display>
        <Body muted>{t("updateBody")}</Body>
        <Button label={t("continue")} onPress={() => Linking.openURL(platform === "android" ? "https://play.google.com/store/apps/details?id=com.rayz.team" : "https://apps.apple.com/app/rayz-team")} />
      </Screen>
    );
  }
  if (gate === "offline") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("offlineTitle")}</Display>
        <Body muted>{t("offlineBody")}</Body>
        <Button label={t("retry")} onPress={() => void config.refetch()} />
      </Screen>
    );
  }
  return children;
}
