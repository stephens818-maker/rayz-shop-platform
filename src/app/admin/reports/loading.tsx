import { ChartSkeleton, LoadingRegion, PageHeaderSkeleton, Skeleton, StatsSkeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <LoadingRegion label="Loading the report" className="mx-auto max-w-6xl">
      <PageHeaderSkeleton />
      <div className="mb-4 flex flex-wrap gap-1 border-b border-zinc-200 pb-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-7 w-24 rounded-md" />
        ))}
      </div>
      <div className="mb-4 flex flex-wrap gap-2">
        <Skeleton className="h-9 w-40 rounded-lg" />
        <Skeleton className="h-9 w-56 rounded-lg" />
        <Skeleton className="h-9 w-32 rounded-lg" />
      </div>
      <StatsSkeleton />
      <ChartSkeleton />
      <TableSkeleton className="mt-4" rows={10} />
    </LoadingRegion>
  );
}
