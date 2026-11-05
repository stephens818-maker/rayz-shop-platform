import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "../src/session";

export default function Index() {
  const { session, ready } = useSession();
  if (!ready) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  return <Redirect href={session ? "/(app)/home" : "/welcome"} />;
}
