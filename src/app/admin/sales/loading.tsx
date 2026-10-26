import { LoadingRegion, PageHeaderSkeleton, StatsSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <LoadingRegion label="Loading sales" className="mx-auto max-w-6xl">
      <PageHeaderSkeleton actions={2} />
      <StatsSkeleton />
      <TableSkeleton className="mt-4" rows={12} cols={6} />
    </LoadingRegion>
  );
}
