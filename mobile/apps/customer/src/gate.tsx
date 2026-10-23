import { setTimeFormat, type AppConfig } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { Linking } from "react-native";
import { Body, Button, Display, Screen, useI18n } from "@rayz/ui";
import { api, APP_VERSION } from "./net";
import { bootGate } from "./boot-gate";

export function ConfigGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const config = useQuery({ queryKey: ["app-config"], queryFn: () => api<AppConfig>("/api/v1/app/config") });
  useEffect(() => {
    if (config.data?.timeFormat) setTimeFormat(config.data.timeFormat);
  }, [config.data?.timeFormat]);
  const gate = config.data
    ? bootGate({ launched: config.data.launched, launchAt: config.data.launchAt, minVersion: config.data.minVersion }, APP_VERSION)
    : "open";
  if (gate === "update") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("updateRequired")}</Display>
        <Body muted>{t("updateBody")}</Body>
        <Button label={t("continue")} onPress={() => Linking.openURL("https://apps.apple.com/app/rayz")} />
      </Screen>
    );
  }
  if (gate === "coming-soon") {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("comingSoon")}</Display>
        {config.data?.launchAt ? <Body muted>{config.data.launchAt.slice(0, 10)}</Body> : null}
      </Screen>
    );
  }
  return children;
}
