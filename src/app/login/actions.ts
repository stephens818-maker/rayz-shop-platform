"use server";

import { redirect } from "next/navigation";
import { audit } from "@/server/audit";
import { loadStaffAccess } from "@/server/auth/access";
import { endSession, startSession, verifyPassword } from "@/server/auth/staff";

export async function login(_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const user = await verifyPassword(email, password);
  if (!user) return { error: "Email or password is incorrect" };
  const access = await loadStaffAccess(user.id);
  if (!access) return { error: "Email or password is incorrect" };
  await startSession(user.id);
  await audit({ staffId: user.id, label: `${access.role.name}:${user.displayLabel}` }, "staff.login", "staff", user.id, {}, access.scope === "all" ? null : (access.shopIds[0] ?? null));
  const next = String(form.get("next") ?? "");
  redirect(next.startsWith("/admin") ? next : access.permissions.has("sales.view") ? "/admin" : "/admin/calendar");
}

export async function logout() {
  await endSession();
  redirect("/login");
}
