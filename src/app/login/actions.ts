"use server";

import { redirect } from "next/navigation";
import { audit } from "@/server/audit";
import { endSession, startSession, verifyPassword } from "@/server/auth/staff";

export async function login(_prev: { error: string } | null, form: FormData): Promise<{ error: string } | null> {
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const user = await verifyPassword(email, password);
  if (!user) return { error: "Email or password is incorrect" };
  await startSession(user.id, user.role);
  await audit({ staffId: user.id, label: `${user.role}:${user.displayLabel}` }, "staff.login", "staff", user.id, {}, user.managerShopId);
  const next = String(form.get("next") ?? "");
  redirect(next.startsWith("/admin") ? next : user.role === "barber" ? "/admin/calendar" : "/admin");
}

export async function logout() {
  await endSession();
  redirect("/login");
}
