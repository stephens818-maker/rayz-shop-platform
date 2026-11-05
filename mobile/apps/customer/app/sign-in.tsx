import { useState } from "react";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { Button, Display, Field, Screen, useI18n } from "@rayz/ui";
import { peekDraft } from "../src/draft";
import { api } from "../src/net";
import { useSession } from "../src/session";

interface Profile { id: string; firstName: string }
interface Verify {
  chooseProfile?: boolean;
  needsProfile?: boolean;
  selectionToken?: string;
  profiles?: Profile[];
  accessToken?: string;
  refreshToken?: string;
  customer?: { id: string; firstName: string };
}

export default function SignIn() {
  const { t } = useI18n();
  const router = useRouter();
  const { save } = useSession();
  const [step, setStep] = useState<"phone" | "code" | "choose" | "name">("phone");
  const [phone, setPhone] = useState("3195550100");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<Verify | null>(null);
  const [error, setError] = useState("");

  const finish = async (body: Verify) => {
    if (!body.accessToken || !body.customer) return;
    await save({ token: body.accessToken, refreshToken: body.refreshToken ?? "", firstName: body.customer.firstName, customerId: body.customer.id });
    const draft = peekDraft();
    router.replace(draft ? `/book-visit?slug=${draft.slug}&resume=1` : "/(app)/home");
  };

  const sendCode = async () => {
    setError("");
    await api("/api/v1/auth/otp/start", null, { method: "POST", body: JSON.stringify({ phone }) });
    setStep("code");
  };
  const verify = async () => {
    setError("");
    try {
      const body = await api<Verify>("/api/v1/auth/otp/verify", null, { method: "POST", body: JSON.stringify({ phone, code }) });
      setPending(body);
      if (body.chooseProfile) setStep("choose");
      else if (body.needsProfile) setStep("name");
      else await finish(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Try again");
    }
  };
  const choose = async (customerId: string) => {
    const body = await api<Verify>("/api/v1/auth/otp/complete", null, { method: "POST", body: JSON.stringify({ selectionToken: pending?.selectionToken, customerId }) });
    await finish(body);
  };
  const create = async () => {
    const body = await api<Verify>("/api/v1/auth/otp/complete", null, { method: "POST", body: JSON.stringify({ selectionToken: pending?.selectionToken, firstName: name }) });
    await finish(body);
  };

  return (
    <Screen>
      <Display>{step === "phone" ? t("phoneTitle") : step === "code" ? t("codeTitle") : step === "choose" ? t("chooseTitle") : t("createTitle")}</Display>
      {step === "phone" ? <Field label="Mobile" value={phone} onChangeText={setPhone} keyboardType="phone-pad" textContentType="telephoneNumber" autoComplete="tel" /> : null}
      {step === "code" ? <Field label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" textContentType="oneTimeCode" autoComplete="sms-otp" maxLength={6} /> : null}
      {step === "name" ? <Field label="First name" value={name} onChangeText={setName} /> : null}
      {step === "choose" ? (
        <View style={{ gap: 10 }}>
          {pending?.profiles?.map((profile) => (
            <Pressable key={profile.id} accessibilityRole="button" onPress={() => choose(profile.id)} style={{ minHeight: 56, borderRadius: 16, backgroundColor: "#FFFBF6", borderWidth: 1, borderColor: "#E4D7C6", justifyContent: "center", paddingHorizontal: 16 }}>
              <Text style={{ fontSize: 18, fontWeight: "700" }}>{profile.firstName}</Text>
            </Pressable>
          ))}
        </View>
      ) : (
        <Button label={t("continue")} onPress={step === "phone" ? sendCode : step === "code" ? verify : create} />
      )}
      {error ? <Text style={{ color: "#8E2F2F" }}>{error}</Text> : null}
      <Text style={{ color: "#4E453C" }}>{t("sandboxHint")}</Text>
    </Screen>
  );
}
