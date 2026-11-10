import { LoadingRegion, Skeleton } from "@/components/skeleton";

const COLUMNS = [
  ["h-16", "h-24", "h-12"],
  ["h-24", "h-12", "h-20"],
  ["h-12", "h-20", "h-16"],
  ["h-20", "h-16", "h-24"],
  ["h-16", "h-12", "h-12"],
];

export default function Loading() {
  return (
    <LoadingRegion label="Loading the calendar" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-36 rounded-lg" />
          <Skeleton className="h-9 w-32 rounded-lg" />
          <Skeleton className="h-9 w-24 rounded-lg" />
        </div>
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-20 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex h-[calc(100dvh-14rem)] overflow-hidden rounded-xl bg-white ring-1 ring-zinc-200">
        <div className="w-14 shrink-0 border-r border-zinc-200" />
        {COLUMNS.map((blocks, c) => (
          <div key={c} className="min-w-0 flex-1 space-y-8 border-r border-zinc-100 p-2 last:border-r-0">
            <Skeleton className="h-5 w-2/3" />
            {blocks.map((h, i) => (
              <Skeleton key={i} className={`w-full rounded-md ${h}`} />
            ))}
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}
