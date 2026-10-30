"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Input } from "@/components/ui";

/** "Shops near me": the browser's location (asked for only on the tap), or a ZIP. Nothing is stored. */
export function NearMe({ zip: initialZip, basePath = "/locations" }: { zip?: string | null; basePath?: string }) {
  const router = useRouter();
  const [zip, setZip] = useState(initialZip ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function locate() {
    if (!navigator.geolocation) return setError("Your browser can't share its location. Enter a ZIP instead.");
    setBusy(true);
    setError(null);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setBusy(false);
        router.push(`${basePath}?near=${p.coords.latitude.toFixed(3)},${p.coords.longitude.toFixed(3)}`);
      },
      () => {
        setBusy(false);
        setError("We couldn't get your location. Enter a ZIP instead.");
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 600_000 },
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" onClick={locate} disabled={busy}>
        {busy ? "Finding you…" : "Shops near me"}
      </Button>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!/^\d{5}$/.test(zip.trim())) return setError("Enter a 5-digit ZIP");
          setError(null);
          router.push(`${basePath}?zip=${zip.trim()}`);
        }}
      >
        <Input aria-label="ZIP code" inputMode="numeric" maxLength={5} placeholder="ZIP" value={zip} onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} className="w-24" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>
      {error && <p className="w-full text-sm text-red-600">{error}</p>}
    </div>
  );
}
