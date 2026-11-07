"use client";

import { useState } from "react";
import { useAction } from "@/components/use-action";
import { Button, Notice } from "@/components/ui";

/** One photo, turned into a small data URL in the browser. Nothing is sent until Save. */
export function PhotoUpload({ label, current, save }: { label: string; current: string | null; save: (dataUrl: string) => Promise<{ ok: true; data: unknown } | { ok: false; error: string }> }) {
  const { pending, error, run } = useAction();
  const [preview, setPreview] = useState<string | null>(null);
  const shown = preview ?? current;
  return (
    <div className="flex items-center gap-3">
      {shown ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={shown} alt="" className="h-14 w-14 rounded-full object-cover ring-1 ring-zinc-200" />
      ) : (
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-full bg-zinc-100 text-xs text-zinc-500">Photo</span>
      )}
      <div className="space-y-1">
        <label className="block text-sm font-medium text-zinc-800">
          {label}
          <input
            type="file"
            accept="image/jpeg,image/png"
            className="mt-1 block text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 150_000) {
                setPreview(null);
                return;
              }
              const reader = new FileReader();
              reader.onload = () => setPreview(typeof reader.result === "string" ? reader.result : null);
              reader.readAsDataURL(file);
            }}
          />
        </label>
        <Button size="sm" disabled={pending || !preview} onClick={() => preview && run(() => save(preview), () => setPreview(null), "Photo saved")}>
          Save photo
        </Button>
        {error && <Notice tone="red">{error}</Notice>}
      </div>
    </div>
  );
}
