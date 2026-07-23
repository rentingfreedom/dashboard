import { redirect } from "next/navigation";
import { getAuthedUser } from "@/lib/auth/roles";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const user = await getAuthedUser();
  if (user?.role !== "admin") {
    redirect("/properties");
  }

  return <SettingsClient currentUserId={user.id} />;
}
