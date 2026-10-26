import { LoadingRegion, PageHeaderSkeleton, StatsSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <LoadingRegion className="mx-auto max-w-6xl">
      <PageHeaderSkeleton />
      <StatsSkeleton />
      <TableSkeleton className="mt-4" />
    </LoadingRegion>
  );
}
