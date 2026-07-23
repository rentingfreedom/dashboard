"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, Lock, CalendarCheck, Activity, Settings, Sun, Moon } from "lucide-react";
import { useTheme } from "next-themes";
import { UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { useRole } from "@/lib/auth/use-role";

const navItems = [
  { href: "/properties", label: "Properties", icon: Building2 },
  { href: "/lockboxes", label: "Lockboxes", icon: Lock },
  { href: "/showings", label: "Showings", icon: CalendarCheck },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings, adminOnly: true },
];

export function Sidebar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const { isAdmin } = useRole();

  if (pathname === "/sign-in") {
    return null;
  }

  const visibleNavItems = navItems.filter((item) => !item.adminOnly || isAdmin);

  return (
    <aside className="w-56 shrink-0 flex flex-col bg-white dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 min-h-full">
      {/* Logo */}
      <div className="h-16 flex items-center px-4 border-b border-gray-800 bg-gray-900">
        <Link href="/properties" className="block w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="Renting Freedom"
            className="w-full max-w-[160px] h-auto object-contain object-left"
          />
        </Link>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 space-y-0.5">
        {visibleNavItems.map(({ href, label, icon: Icon }) => {
          const active = pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                  : "text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100"
              )}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0",
                  active ? "text-amber-600 dark:text-amber-400" : "text-gray-400 dark:text-gray-500"
                )}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
        <p className="text-xs text-gray-400 dark:text-gray-500">Operations Dashboard</p>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="p-1.5 rounded-md text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            title="Toggle dark mode"
          >
            {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
          <UserButton />
        </div>
      </div>
    </aside>
  );
}
