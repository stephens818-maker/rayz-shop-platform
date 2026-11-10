import { maskEmail, maskPhone } from "./client-privacy";
import type { Permission } from "./permissions";

/**
 * Staff phone numbers and email addresses are masked for anyone without "See staff contact
 * details", except on their own profile. Shop logins never have it.
 */
export const seesStaffContact = (viewer: { permissions: ReadonlySet<Permission>; staffId: string }, personId: string) => viewer.staffId === personId || viewer.permissions.has("staff.contact");

export function staffContact<T extends { email: string | null; phone: string | null }>(sees: boolean, c: T): T & { masked: boolean } {
  return sees ? { ...c, masked: false } : { ...c, email: maskEmail(c.email), phone: maskPhone(c.phone), masked: true };
}
