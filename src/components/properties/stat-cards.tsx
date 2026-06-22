"use client";

import { Building2, Home, Users, AlertTriangle, Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Property } from "@/lib/types";

interface StatCardsProps {
  properties: Property[];
}

export function StatCards({ properties }: StatCardsProps) {
  const active = properties.filter((p) => p.active);
  const vacant = active.filter((p) => p.status === "vacant");
  const occupied = active.filter((p) => p.status === "occupied");
  const withLockbox = active.filter((p) => p.populife_lock_id);
  const needsAttention = active.filter((p) =>
    ["error", "pending_create", "pending_deactivate"].includes(p.provisioning_status)
  );

  const stats = [
    {
      label: "Active Properties",
      value: active.length,
      icon: Building2,
      color: "text-slate-600 dark:text-slate-400",
      bg: "bg-slate-100 dark:bg-slate-800",
    },
    {
      label: "Vacant",
      value: vacant.length,
      icon: Home,
      color: "text-amber-600 dark:text-amber-400",
      bg: "bg-amber-100 dark:bg-amber-900/40",
    },
    {
      label: "Occupied",
      value: occupied.length,
      icon: Users,
      color: "text-green-600 dark:text-green-400",
      bg: "bg-green-100 dark:bg-green-900/40",
    },
    {
      label: "Lockboxes Assigned",
      value: withLockbox.length,
      icon: Lock,
      color: "text-blue-600 dark:text-blue-400",
      bg: "bg-blue-100 dark:bg-blue-900/40",
    },
    {
      label: "Needs Attention",
      value: needsAttention.length,
      icon: AlertTriangle,
      color: needsAttention.length > 0 ? "text-red-600 dark:text-red-400" : "text-slate-400 dark:text-slate-600",
      bg: needsAttention.length > 0 ? "bg-red-100 dark:bg-red-900/40" : "bg-slate-100 dark:bg-slate-800",
    },
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
