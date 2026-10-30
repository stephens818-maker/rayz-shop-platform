"use client";

import { useState } from "react";
import { MessageHistoryList, type MessageHistoryLine } from "@/components/message-history";
import { appointmentMessagesAction } from "./actions";

/** "Messages" on the appointment panel: loaded when opened, so the calendar doesn't fetch them for every booking. */
export function AppointmentMessages({ appointmentId }: { appointmentId: string }) {
  const [lines, setLines] = useState<MessageHistoryLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <details
      className="rounded-lg ring-1 ring-zinc-200"
      onToggle={(e) => {
        if (!e.currentTarget.open || lines) return;
        void appointmentMessagesAction(appointmentId).then((r) => (r.ok ? setLines(r.data) : setError(r.error)));
      }}
    >
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-zinc-700">Messages to the client</summary>
      <div className="px-3 pb-2">
        {error ? <p className="text-sm text-red-700">{error}</p> : !lines ? <p className="text-sm text-zinc-500">Loading…</p> : lines.length ? <MessageHistoryList lines={lines} /> : <p className="text-sm text-zinc-500">None yet.</p>}
      </div>
    </details>
  );
}
