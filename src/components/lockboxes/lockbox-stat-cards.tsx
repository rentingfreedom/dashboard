"use client";

import { Lock, CheckCircle, AlertTriangle, Archive, Package } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Lockbox } from "@/lib/types";

export function LockboxStatCards({ lockboxes }: { lockboxes: Lockbox[] }) {
  const active = lockboxes.filter((l) => l.active);
  const available = active.filter((l) => l.status === "available");
  const assigned = active.filter((l) => l.status === "assigned");
  const problem = active.filter((l) => ["maintenance", "lost"].includes(l.status));
  const retired = lockboxes.filter((l) => l.status === "retired");

  const stats = [
    { label: "Total", value: lockboxes.length, icon: Package, color: "text-slate-600 dark:text-slate-400", bg: "bg-slate-100 dark:bg-slate-800" },
    { label: "Available", value: available.length, icon: CheckCircle, color: "text-green-600 dark:text-green-400", bg: "bg-green-100 dark:bg-green-900/40" },
    { label: "Assigned", value: assigned.length, icon: Lock, color: "text-blue-600 dark:text-blue-400", bg: "bg-blue-100 dark:bg-blue-900/40" },
    { label: "Maintenance / Lost", value: problem.length, icon: AlertTriangle, color: problem.length > 0 ? "text-amber-600 dark:text-amber-400" : "text-slate-400", bg: problem.length > 0 ? "bg-amber-100 dark:bg-amber-900/40" : "bg-slate-100 dark:bg-slate-800" },
    { label: "Retired", value: retired.length, icon: Archive, color: "text-slate-400 dark:text-slate-600", bg: "bg-slate-100 dark:bg-slate-800" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
      {stats.map(({ label, value, icon: Icon, color, bg }) => (
        <Card key={label} className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-none">
          <CardContent className="p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">{label}</p>
                <p className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mt-1">{value}</p>
              </div>
              <div className={`p-2 rounded-lg ${bg}`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
