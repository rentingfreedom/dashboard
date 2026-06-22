import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function StatusBadge({ status }: { status: string }) {
  const s = status?.toLowerCase();
  const styles =
    s === "occupied"
      ? "bg-green-100 text-green-700 border-green-200"
      : s === "vacant"
      ? "bg-amber-100 text-amber-700 border-amber-200"
      : "bg-gray-100 text-gray-500 border-gray-200";

  return (
    <Badge variant="outline" className={cn("text-xs font-medium capitalize", styles)}>
      {status || "—"}
    </Badge>
  );
}

export function ProvisioningBadge({ status }: { status: string }) {
  const s = status?.toLowerCase();

  const config: Record<string, { label: string; styles: string }> = {
    subscribed:        { label: "Ready",           styles: "bg-green-100 text-green-700 border-green-200" },
    active:            { label: "Ready",           styles: "bg-green-100 text-green-700 border-green-200" },
    pending_create:    { label: "Pending Setup",   styles: "bg-blue-100 text-blue-700 border-blue-200" },
    creating:          { label: "Creating…",       styles: "bg-blue-100 text-blue-700 border-blue-200" },
    error:             { label: "Error",           styles: "bg-red-100 text-red-700 border-red-200" },
    pending_deactivate:{ label: "Deactivating",    styles: "bg-orange-100 text-orange-700 border-orange-200" },
    deactivating:      { label: "Deactivating…",   styles: "bg-orange-100 text-orange-700 border-orange-200" },
    deactivated:       { label: "Inactive",        styles: "bg-gray-100 text-gray-500 border-gray-200" },
  };

  const match = config[s] ?? { label: s || "—", styles: "bg-gray-100 text-gray-500 border-gray-200" };

  return (
    <Badge variant="outline" className={cn("text-xs font-medium", match.styles)}>
      {match.label}
    </Badge>
  );
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? null : (
    <Badge variant="outline" className="text-xs font-medium bg-gray-100 text-gray-500 border-gray-200">
      Inactive
    </Badge>
  );
}
