import { bootGate, chicagoDate, formatLongDate, localeFor, setTimeFormat, type AppConfig } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { Body, Button, Display, Screen, useI18n } from "@rayz/ui";
import { ApiError, api, APP_VERSION } from "./net";

const platform = Platform.OS === "android" ? "android" : "ios";

export function ConfigGate({ children }: { children: ReactNode }) {
  const { t, lang } = useI18n();
  const locale = localeFor(lang);
  const config = useQuery({
    queryKey: ["app-config"],
    retry: false,
    queryFn: () => api<AppConfig>("/api/v1/app/config", null, { headers: { "x-client": platform } }),
  });
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
  const status = config.error instanceof ApiError ? config.error.status : undefined;
  const gate = config.isSuccess ? bootGate(config.data, APP_VERSION, platform) : bootGate(null, APP_VERSION, platform, status);
  if (gate === "update") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("updateRequired")}</Display>
        <Body muted>{t("updateBody")}</Body>
        <Button label={t("continue")} onPress={() => Linking.openURL(platform === "android" ? "https://play.google.com/store/apps/details?id=com.rayz.customer" : "https://apps.apple.com/app/rayz")} />
      </Screen>
    );
  }
  if (gate === "coming-soon") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("comingSoon")}</Display>
        {config.data?.launchAt ? <Body muted>{formatLongDate(chicagoDate(config.data.launchAt), locale)}</Body> : null}
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
