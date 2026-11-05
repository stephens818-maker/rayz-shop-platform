import { useState } from "react";
import { useRouter } from "expo-router";
import { Text } from "react-native";
import { Button, Display, Field, Screen, useI18n } from "@rayz/ui";
import { API_URL } from "../src/net";
import { useStaff } from "../src/session";

interface Verified {
  accessToken: string;
  refreshToken: string;
  staff: { id: string; firstName: string };
}

export default function SignIn() {
  const { t } = useI18n();
  const router = useRouter();
  const { save, elevate } = useStaff();
  const [step, setStep] = useState<"phone" | "code" | "pin">("phone");
  const [phone, setPhone] = useState("3195550111");
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const sendCode = async () => {
    setError("");
    await fetch(`${API_URL}/api/staff/v1/auth/otp/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone }) });
    setStep("code");
  };
  const verify = async () => {
    setError("");
    const res = await fetch(`${API_URL}/api/staff/v1/auth/otp/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, code }) });
    const body = (await res.json()) as Verified & { error?: { message: string } };
    if (!res.ok) {
      setError(body.error?.message ?? t("retry"));
      return;
    }
    await save({ token: body.accessToken, refreshToken: body.refreshToken, firstName: body.staff.firstName, staffId: body.staff.id });
    setStep("pin");
  };
  const confirmPin = async () => {
    setError("");
    try {
      await elevate(pin);
      router.replace("/(app)/today");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("retry"));
    }
  };

  return (
    <Screen>
      <Display>{step === "phone" ? t("phoneTitle") : step === "code" ? t("codeTitle") : t("pinTitle")}</Display>
      {step === "pin" ? <Text style={{ color: "#4E453C", fontSize: 17 }}>{t("pinHint")}</Text> : null}
      {step === "phone" ? <Field label="Mobile" value={phone} onChangeText={setPhone} keyboardType="phone-pad" /> : null}
      {step === "code" ? <Field label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} /> : null}
      {step === "pin" ? <Field label="PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={6} /> : null}
      <Button label={t("continue")} onPress={() => { void (step === "phone" ? sendCode() : step === "code" ? verify() : confirmPin()); }} />
      {error ? <Text style={{ color: "#8E2F2F" }}>{error}</Text> : null}
      <Text style={{ color: "#4E453C" }}>{t("staffHint")}</Text>
    </Screen>
  );
}
