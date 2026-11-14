import { redirect } from "next/navigation";

/** The front desk's register. Shop logins land on Checkout; this is the same place. */
export default function PosPage() {
  redirect("/admin/sales");
}
