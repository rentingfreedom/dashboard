import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATUS_CONFIG: Record<string, { label: string; styles: string }> = {
  available:   { label: "Available",   styles: "bg-green-100 text-green-700 border-green-200 dark:bg-green-900/40 dark:text-green-400 dark:border-green-800" },
  assigned:    { label: "Assigned",    styles: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-900/40 dark:text-blue-400 dark:border-blue-800" },
  maintenance: { label: "Maintenance", styles: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-800" },
  lost:        { label: "Lost",        styles: "bg-red-100 text-red-700 border-red-200 dark:bg-red-900/40 dark:text-red-400 dark:border-red-800" },
  retired:     { label: "Retired",     styles: "bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-500 dark:border-gray-700" },
};

export function LockboxStatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status?.toLowerCase()] ?? { label: status || "—", styles: "bg-gray-100 text-gray-500 border-gray-200" };
  return (
    <Badge variant="outline" className={cn("text-xs font-medium", cfg.styles)}>
      {cfg.label}
    </Badge>
  );
}
