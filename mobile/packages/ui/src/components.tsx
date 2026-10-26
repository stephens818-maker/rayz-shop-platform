import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type PressableProps, type TextInputProps, type ViewProps } from "react-native";
import { colors, hit, space, type as font } from "./theme";

export function Screen({ children, style }: ViewProps) {
  return <View style={[styles.screen, style]}>{children}</View>;
}

export function ScrollScreen({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {children}
    </ScrollView>
  );
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.ink} />
      <Text style={[styles.body, styles.muted]}>{label}</Text>
    </View>
  );
}

export function Display({ children }: { children: string }) {
  return <Text style={styles.display} accessibilityRole="header">{children}</Text>;
}

export function Title({ children }: { children: string }) {
  return <Text style={styles.title} accessibilityRole="header">{children}</Text>;
}

export function Body({ children, muted }: { children: string; muted?: boolean }) {
  return <Text style={[styles.body, muted && styles.muted]}>{children}</Text>;
}

export function Button({ label, kind = "primary", onPress, disabled }: { label: string; kind?: "primary" | "secondary" | "ghost" | "danger"; onPress?: PressableProps["onPress"]; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, styles[kind], pressed && styles.pressed, disabled && styles.disabled]}>
      <Text style={[styles.buttonText, kind !== "primary" && kind !== "danger" && styles.buttonTextDark]}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: ViewProps) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.inkSoft} style={styles.input} {...props} />
    </View>
  );
}

export function Money({ cents, large }: { cents: number; large?: boolean }) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const text = `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
  return <Text style={large ? styles.moneyLarge : styles.money} accessibilityLabel={text}>{text}</Text>;
}

export function Banner({ tone = "info", children }: { tone?: "info" | "good" | "bad"; children: string }) {
  return (
    <View style={[styles.banner, tone === "good" && styles.bannerGood, tone === "bad" && styles.bannerBad]}>
      <Text style={styles.body}>{children}</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <Title>{title}</Title>
      <Body muted>{body}</Body>
    </Card>
  );
}

export function Chip({ label, selected, onPress }: { label: string; selected?: boolean; onPress?: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && styles.chipOn]}>
      <Text style={[styles.chipText, selected && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ label, value, onPress }: { label: string; value?: string; onPress?: () => void }) {
  const content = (
    <View style={styles.row}>
      <Text style={styles.body}>{label}</Text>
      {value ? <Text style={styles.rowValue}>{value}</Text> : null}
    </View>
  );
  if (!onPress) return content;
  return <Pressable accessibilityRole="button" onPress={onPress} style={styles.rowHit}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper, padding: space.lg, gap: space.md },
  scroll: { flex: 1, backgroundColor: colors.paper },
  scrollContent: { padding: space.lg, gap: space.md, paddingBottom: 64 },
  loading: { minHeight: 160, alignItems: "center", justifyContent: "center", gap: space.sm },
  display: { fontSize: font.display, lineHeight: 40, color: colors.ink, fontWeight: "700", letterSpacing: -0.6 },
  title: { fontSize: font.title, lineHeight: 30, color: colors.ink, fontWeight: "700" },
  body: { fontSize: font.body, lineHeight: 24, color: colors.ink },
  muted: { color: colors.inkSoft },
  button: { minHeight: hit + 4, borderRadius: 16, alignItems: "center", justifyContent: "center", paddingHorizontal: space.lg },
  primary: { backgroundColor: colors.ink },
  secondary: { backgroundColor: colors.goldSoft },
  ghost: { backgroundColor: "transparent", borderWidth: 1.5, borderColor: colors.line },
  danger: { backgroundColor: colors.bad },
  pressed: { opacity: 0.86 },
  disabled: { opacity: 0.45 },
  buttonText: { color: colors.goldSoft, fontSize: font.body, fontWeight: "700" },
  buttonTextDark: { color: colors.ink },
  card: { backgroundColor: colors.card, borderRadius: 20, padding: space.lg, gap: space.sm, borderWidth: 1, borderColor: colors.line },
  field: { gap: space.xs },
  label: { color: colors.inkSoft, fontSize: font.small, fontWeight: "600" },
  input: { minHeight: hit + 4, borderRadius: 14, borderWidth: 1.5, borderColor: colors.line, backgroundColor: colors.white, paddingHorizontal: space.md, fontSize: 20, color: colors.ink },
  money: { fontSize: 20, fontWeight: "700", color: colors.ink, fontVariant: ["tabular-nums"] },
  moneyLarge: { fontSize: 40, lineHeight: 46, fontWeight: "700", color: colors.ink, fontVariant: ["tabular-nums"] },
  banner: { backgroundColor: colors.goldSoft, borderRadius: 14, padding: space.md },
  bannerGood: { backgroundColor: colors.goodSoft },
  bannerBad: { backgroundColor: colors.badSoft },
  chip: { minHeight: hit, borderRadius: 999, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.white, borderWidth: 1.5, borderColor: colors.line },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  chipTextOn: { color: colors.goldSoft },
  row: { minHeight: hit, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md },
  rowHit: { borderRadius: 12 },
  rowValue: { color: colors.inkSoft, fontSize: font.body, flexShrink: 1, textAlign: "right" },
});
