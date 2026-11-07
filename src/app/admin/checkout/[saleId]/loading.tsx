import { LoadingRegion, Skeleton } from "@/components/skeleton";

export default function Loading() {
  return (
    <LoadingRegion label="Loading the ticket" className="mx-auto max-w-6xl">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-4">
          <div className="grid gap-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200 sm:grid-cols-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
          <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
            <Skeleton className="h-4 w-20" />
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Array.from({ length: 9 }, (_, i) => (
                <Skeleton key={i} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div className="rounded-xl bg-white p-4 ring-1 ring-zinc-200">
            <Skeleton className="h-4 w-12" />
            <div className="mt-4 grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-12 w-full rounded-lg" />
              ))}
            </div>
          </div>
          <div className="space-y-3 rounded-xl bg-white p-4 ring-1 ring-zinc-200">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        </div>
      </div>
    </LoadingRegion>
  );
}
