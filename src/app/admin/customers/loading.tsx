import { LoadingRegion, PageHeaderSkeleton, Skeleton, TableSkeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <LoadingRegion label="Loading clients" className="mx-auto max-w-6xl">
      <PageHeaderSkeleton actions={2} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Skeleton className="h-10 w-full max-w-md rounded-lg" />
        <Skeleton className="h-10 w-32 rounded-lg" />
      </div>
      <TableSkeleton rows={12} cols={4} />
    </LoadingRegion>
  );
}
