import { setTimeFormat, type StaffConfig } from "@rayz/api";
import { useQuery, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { useEffect } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "@rayz/ui";
import { API_URL } from "../src/net";
import { SessionProvider } from "../src/session";

const client = new QueryClient();

function TimeFormat() {
  const config = useQuery({
    queryKey: ["staff-config"],
    queryFn: async () => {
      const res = await fetch(`${API_URL}/api/staff/v1/config`);
      if (!res.ok) throw new Error("config");
      return (await res.json()) as StaffConfig;
    },
  });
  useEffect(() => {
    if (config.data?.timeFormat) setTimeFormat(config.data.timeFormat);
  }, [config.data?.timeFormat]);
  return null;
}

export default function Root() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <SessionProvider>
            <TimeFormat />
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F4EFE6" } }} />
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
