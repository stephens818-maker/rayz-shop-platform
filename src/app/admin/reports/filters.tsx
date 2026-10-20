import Link from "next/link";
import { Button, cx } from "@/components/ui";
import { PRESETS } from "./scope";

export function ReportFilters({
  base,
  preset,
  from,
  to,
  shop,
  staff,
  shops,
  barbers,
  showShop,
}: {
  base: string;
  preset: string | null;
  from: string;
  to: string;
  shop: string | null;
  staff: string | null;
  shops: { id: string; name: string }[];
  barbers: { id: string; label: string }[] | null;
  showShop: boolean;
}) {
  const qs = (extra: Record<string, string | null>) => {
    const q = new URLSearchParams();
    if (shop) q.set("shop", shop);
    if (staff) q.set("staff", staff);
    for (const [k, v] of Object.entries(extra)) if (v) q.set(k, v);
    return `${base}?${q}`;
  };
  return (
    <div className="no-print mb-5 space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <Link
            key={p.id}
            href={qs({ preset: p.id })}
            className={cx("rounded-full px-3 py-1 text-sm ring-1", preset === p.id ? "bg-ink-900 text-white ring-ink-900" : "bg-white ring-zinc-300 hover:bg-zinc-50")}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <form className="flex flex-wrap items-end gap-2 text-sm" action={base}>
        <label>
          <span className="block text-xs text-zinc-500">From</span>
          <input type="date" name="from" defaultValue={from} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        <label>
          <span className="block text-xs text-zinc-500">To</span>
          <input type="date" name="to" defaultValue={to} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300" />
        </label>
        {showShop && (
          <label>
            <span className="block text-xs text-zinc-500">Shop</span>
            <select name="shop" defaultValue={shop ?? ""} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
              <option value="">Current selection</option>
              <option value="all">All shops</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {barbers && (
          <label>
            <span className="block text-xs text-zinc-500">Barber</span>
            <select name="staff" defaultValue={staff ?? ""} className="h-9 rounded-lg px-2 ring-1 ring-zinc-300">
              <option value="">All barbers</option>
              {barbers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <Button type="submit" variant="dark" size="sm" className="h-9">
          Apply
        </Button>
      </form>
    </div>
  );
}
