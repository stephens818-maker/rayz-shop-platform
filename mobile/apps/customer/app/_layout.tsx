import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { I18nProvider } from "@rayz/ui";
import { ConfigGate } from "../src/gate";
import { SessionProvider } from "../src/session";
import { StripeRoot } from "../src/stripe-root";

const client = new QueryClient();

export default function Root() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <I18nProvider>
          <SessionProvider>
            <StripeRoot>
              <ConfigGate>
                <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#F4EFE6" } }} />
              </ConfigGate>
            </StripeRoot>
          </SessionProvider>
        </I18nProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
