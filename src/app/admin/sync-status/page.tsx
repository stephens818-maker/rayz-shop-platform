import type { Metadata } from "next";
import { Notice, PageHeader } from "@/components/ui";
import { SYNC_AREAS } from "@/domain/brand-sync";
import { guardPage } from "@/server/auth/staff";
import { syncControls, syncHistory, syncMatrix } from "@/server/brand-sync/engine";
import { ADAPTERS } from "@/server/brand-sync/registry";
import { SyncStatusBoard } from "./board";

export const metadata: Metadata = { title: "Sync status" };

export default async function SyncStatusPage({ searchParams }: { searchParams: Promise<{ tab?: string; area?: string }> }) {
  const ctx = await guardPage("/admin/sync-status");
  const sp = await searchParams;
  const [matrix, history, controls] = await Promise.all([syncMatrix(), syncHistory(), syncControls()]);
  const canAct = ctx.brandWide;
  const mayType = Object.fromEntries(Object.values(ADAPTERS).map((a) => [a.type, canAct && a.brandPerms.some((p) => ctx.permissions.has(p))]));
  const areas = SYNC_AREAS.filter((a) => matrix.rows.some((r) => r.area === a.id));
  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <PageHeader
        title="Sync status"
        subtitle="Every brand-controlled setting at every shop. A shop follows the brand unless it has its own value. Push or reset in bulk, see every sync, and undo one as a whole."
      />
      {!canAct && <Notice tone="blue">You can see where each shop stands. Syncing and undoing need access to every shop.</Notice>}
      <SyncStatusBoard
        matrix={matrix}
        history={history}
        controls={controls}
        areas={areas.map((a) => ({ id: a.id, label: a.label }))}
        mayType={mayType}
        initialTab={sp.tab === "history" || sp.tab === "controls" ? sp.tab : "matrix"}
        initialArea={areas.some((a) => a.id === sp.area) ? (sp.area ?? null) : null}
      />
    </div>
  );
}
