import * as LocalAuthentication from "expo-local-authentication";

/** Face ID unlocks the app only. Clock-in never calls this. */
export async function unlockApp(): Promise<boolean> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock Ray'z Team",
    cancelLabel: "Cancel",
    disableDeviceFallback: false,
  });
  return result.success;
}
