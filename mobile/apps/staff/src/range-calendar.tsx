import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, useI18n } from "@rayz/ui";
import { monthCells } from "./month";

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

export function RangeCalendar({
  today,
  onApply,
}: {
  today: string;
  onApply: (from: string, to: string) => void;
}) {
  const { t } = useI18n();
  const [cursor, setCursor] = useState(`${today.slice(0, 7)}-01`);
  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [year, month] = cursor.split("-").map(Number);
  const cells = monthCells(year, month);

  const pick = (date: string) => {
    if (!start || end) {
      setStart(date);
      setEnd(null);
      return;
    }
    if (date < start) {
      setEnd(start);
      setStart(date);
      return;
    }
    setEnd(date);
  };

  const inRange = (date: string) => {
    if (!start) return false;
    const last = end ?? start;
    return date >= start && date <= last;
  };

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ fontSize: 18, fontWeight: "700" }}>{cursor.slice(0, 7)}</Text>
      <View style={{ flexDirection: "row" }}>
        {WEEKDAYS.map((label, index) => (
          <Text key={`${label}${index}`} style={{ width: "14.28%", textAlign: "center", color: "#4E453C" }}>{label}</Text>
        ))}
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
        {cells.map((cell, index) =>
          cell.date ? (
            <Pressable
              key={cell.date}
              accessibilityRole="button"
              accessibilityLabel={cell.date}
              onPress={() => pick(cell.date!)}
              style={{ width: "14.28%", minHeight: 48, alignItems: "center", justifyContent: "center", borderRadius: 12, backgroundColor: inRange(cell.date) ? "#1C1612" : "transparent" }}
            >
              <Text style={{ color: inRange(cell.date) ? "#F4E3C0" : "#1C1612", fontWeight: cell.date === today ? "800" : "600" }}>{Number(cell.date.slice(8))}</Text>
            </Pressable>
          ) : (
            <View key={`blank-${index}`} style={{ width: "14.28%", minHeight: 48 }} />
          ),
        )}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button label="‹" kind="secondary" onPress={() => setCursor(new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 10))} />
        <Button label="›" kind="secondary" onPress={() => setCursor(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10))} />
      </View>
      <Button label={t("applyRange")} disabled={!start} onPress={() => start && onApply(start, end ?? start)} />
    </View>
  );
}
