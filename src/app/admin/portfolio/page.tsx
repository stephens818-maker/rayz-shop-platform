import { redirect } from "next/navigation";
import { guardPage } from "@/server/auth/staff";

export default async function PortfolioPage() {
  await guardPage("/admin/portfolio");
  redirect("/admin/photos");
}
