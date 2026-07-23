"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { inviteUserSchema, type InviteUserFormValues } from "@/lib/validation/user-schema";
import type { Role } from "@/lib/auth/role-types";

interface Member {
  id: string;
  name: string | null;
  email: string | null;
  role: Role;
  banned: boolean;
  createdAt: number;
}

interface PendingInvitation {
  id: string;
  name: string | null;
  emailAddress: string;
  role: Role;
  createdAt: number;
}

const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  user: "User",
  viewer: "Viewer",
};

export function TeamPanel({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/users");
      if (!res.ok) throw new Error("Failed to load team");
      const data = await res.json();
      setMembers(data.users);
      setInvitations(data.invitations);
    } catch {
      toast.error("Failed to load team members");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function changeRole(userId: string, role: Role) {
    setSavingId(userId);
    try {
      const res = await fetch(`/api/settings/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to update role");
      toast.success("Role updated.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingId(null);
    }
  }

  async function removeMember(userId: string) {
    setSavingId(userId);
    try {
      const res = await fetch(`/api/settings/users/${userId}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to remove user");
      toast.success("User removed.");
      setRemoveTarget(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingId(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    setSavingId(invitationId);
    try {
      const res = await fetch(`/api/settings/invitations/${invitationId}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to revoke invitation");
      toast.success("Invitation revoked.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Card className="border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-none">
      <CardHeader className="pb-2 pt-5 px-5 flex flex-row items-center justify-between">
        <div>
          <CardTitle className="text-sm font-semibold text-gray-900 dark:text-gray-100">Team</CardTitle>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Manage who can access the dashboard and their permission level
          </p>
        </div>
        <Button size="sm" className="h-8" onClick={() => setInviteOpen(true)}>
          <UserPlus className="h-3.5 w-3.5 mr-1.5" />
          Invite
        </Button>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-10 w-full rounded-md" />)}
          </div>
        ) : (
          <div className="space-y-5">
            <div className="space-y-1">
              {members.length === 0 && (
                <p className="text-xs text-gray-400 dark:text-gray-600 py-2">No members found.</p>
              )}
              {members.map((member) => {
                const isSelf = member.id === currentUserId;
                return (
                  <div
                    key={member.id}
                    className="flex items-center justify-between gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                          {member.name || member.email || member.id}
                        </span>
                        {isSelf && <Badge variant="outline" className="text-xs">You</Badge>}
                        {member.banned && (
                          <Badge variant="outline" className="text-xs bg-red-50 text-red-600 border-red-200 dark:bg-red-950 dark:text-red-400">
                            Banned
                          </Badge>
                        )}
                      </div>
                      {member.name && member.email && (
                        <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{member.email}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <NativeSelect
                        value={member.role}
                        disabled={isSelf || savingId === member.id}
                        onChange={(e) => changeRole(member.id, e.target.value as Role)}
                        className="h-8 w-28 text-xs py-0"
                      >
                        <option value="admin">Admin</option>
                        <option value="user">User</option>
                        <option value="viewer">Viewer</option>
                      </NativeSelect>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-gray-400 hover:text-red-600"
                        disabled={isSelf || savingId === member.id}
                        onClick={() => setRemoveTarget(member)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            {invitations.length > 0 && (
              <div>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">Pending invitations</p>
                <div className="space-y-1">
                  {invitations.map((invitation) => (
                    <div
                      key={invitation.id}
                      className="flex items-center justify-between gap-3 py-2 border-b border-gray-100 dark:border-gray-800 last:border-0"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-gray-700 dark:text-gray-300 truncate">
                            {invitation.name || invitation.emailAddress}
                          </span>
                          <Badge variant="outline" className="text-xs">{ROLE_LABEL[invitation.role]}</Badge>
                        </div>
                        {invitation.name && (
                          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">{invitation.emailAddress}</span>
                        )}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-gray-400 hover:text-red-600"
                        disabled={savingId === invitation.id}
                        onClick={() => revokeInvitation(invitation.id)}
                      >
                        Revoke
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>

      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} onSuccess={load} />

      <AlertDialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this user?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{removeTarget?.name || removeTarget?.email}</strong> will lose access to the dashboard immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!savingId}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={!!savingId}
              onClick={() => removeTarget && removeMember(removeTarget.id)}
            >
              {savingId === removeTarget?.id ? "Removing…" : "Remove User"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function InviteDialog({
  open, onOpenChange, onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}) {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<InviteUserFormValues>({
    resolver: zodResolver(inviteUserSchema),
    defaultValues: { role: "viewer" },
  });

  async function onSubmit(values: InviteUserFormValues) {
    try {
      const res = await fetch("/api/settings/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed to send invite");
      toast.success("Invitation sent.");
      reset();
      onOpenChange(false);
      onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite Team Member</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="invite_name">Name <span className="text-red-500">*</span></Label>
            <Input
              id="invite_name"
              placeholder="e.g. Jordan Lee"
              {...register("name")}
              className={errors.name ? "border-red-400" : ""}
            />
            {errors.name && <p className="text-xs text-red-500">{errors.name.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite_email">Email <span className="text-red-500">*</span></Label>
            <Input
              id="invite_email"
              type="email"
              placeholder="name@example.com"
              {...register("emailAddress")}
              className={errors.emailAddress ? "border-red-400" : ""}
            />
            {errors.emailAddress && <p className="text-xs text-red-500">{errors.emailAddress.message}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite_role">Role</Label>
            <NativeSelect id="invite_role" {...register("role")}>
              <option value="admin">Admin</option>
              <option value="user">User</option>
              <option value="viewer">Viewer</option>
            </NativeSelect>
          </div>
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => { reset(); onOpenChange(false); }} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Sending…" : "Send Invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
