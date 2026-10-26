import { CameraView, useCameraPermissions } from "expo-camera";
import { Button, useI18n } from "@rayz/ui";

/** Shop QR only. This screen does not request Face ID. */
export function NativeCamera({ onToken }: { onToken: (token: string) => void }) {
  const { t } = useI18n();
  const [permission, request] = useCameraPermissions();
  if (!permission?.granted) return <Button label={t("sandboxScan")} kind="secondary" onPress={() => request()} />;
  return (
    <CameraView
      style={{ minHeight: 240, borderRadius: 16 }}
      barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
      onBarcodeScanned={({ data }) => onToken(data)}
    />
  );
}
