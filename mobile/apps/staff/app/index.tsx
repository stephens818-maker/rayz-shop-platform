import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useStaff } from "../src/session";

export default function Index() {
  const { session, ready } = useStaff();
  if (!ready) return <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><ActivityIndicator /></View>;
  return <Redirect href={session ? "/(app)/today" : "/sign-in"} />;
}
