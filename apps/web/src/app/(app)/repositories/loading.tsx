import { Skeleton } from "@/components/ui/skeleton";
import { RepositoriesListSkeleton } from "@/components/repositories/repositories-list";

export default function RepositoriesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96" />
      </div>
      <RepositoriesListSkeleton />
    </div>
  );
}
