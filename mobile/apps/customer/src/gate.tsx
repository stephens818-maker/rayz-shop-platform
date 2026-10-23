import type { AppConfig } from "@rayz/api";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Linking } from "react-native";
import { Body, Button, Display, Screen, useI18n } from "@rayz/ui";
import { api, needsUpdate } from "./net";

export function ConfigGate({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const config = useQuery({ queryKey: ["app-config"], queryFn: () => api<AppConfig>("/api/v1/app/config") });
  if (config.data && needsUpdate(config.data.minSupportedVersion.ios)) {
    return (
      <Screen style={{ justifyContent: "flex-end", paddingBottom: 36 }}>
        <Display>{t("updateRequired")}</Display>
        <Body muted>{t("updateBody")}</Body>
        <Button label={t("continue")} onPress={() => Linking.openURL("https://apps.apple.com/app/rayz")} />
      </Screen>
    );
  }
  return children;
}
