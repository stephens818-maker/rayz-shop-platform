import type { Metadata } from "next";
import Link from "next/link";
import { Empty, PageHeader } from "@/components/ui";
import { flags } from "@/lib/flags";
import { formatDate } from "@/lib/time";
import { guardPage } from "@/server/auth/staff";
import { brandFeePolicy, shopFeeRows } from "@/server/payments/card-fee";
import { BrandCardFeeEditor } from "../settings/card-fee-editor";
import { FeeShopsCard, ShopFeeTable } from "./client";

export const metadata: Metadata = { title: "Credit card fee" };

export default async function CardFeePage() {
  const ctx = await guardPage("/admin/card-fee");
  if (!ctx.brandWide) return <Empty title="The brand's credit card fee is set with access to all shops" />;
  const brand = await brandFeePolicy();
  const rows = await shopFeeRows(undefined, brand);
  const { appliesTo, shopIds, shopsCanEdit, ...rules } = brand;
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Credit card fee"
        subtitle={
          <>
            The brand&apos;s credit card fee, which shops use it, and each shop&apos;s setting. Collected and waived fees are in the{" "}
            <Link href="/admin/reports/card-fees" className="underline">
              Credit card fees report
            </Link>
            .
          </>
        }
      />
      <FeeShopsCard key={JSON.stringify({ appliesTo, shopIds, shopsCanEdit })} initial={{ appliesTo, shopIds, shopsCanEdit }} shops={rows.map((r) => ({ id: r.shopId, name: r.name, state: r.state }))} />
      <ShopFeeTable
        rows={rows.map((r) => ({
          shopId: r.shopId,
          name: r.name,
          state: r.state,
          setup: r.status === "setup",
          on: r.on,
          off: r.off,
          fee: r.fee,
          appliesToTip: r.appliesToTip,
          inherits: r.inherits,
          ownKeys: r.ownKeys,
          changed: r.changedAt ? formatDate(r.changedAt, "MMM d, yyyy") : null,
        }))}
      />
      <BrandCardFeeEditor key={JSON.stringify(rules)} initial={brand} canEdit walletFlag={flags.walletFee()} shops={rows.map((r) => ({ name: r.name, state: r.state }))} />
    </div>
  );
}
