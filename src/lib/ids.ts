import { customAlphabet } from "nanoid";

// No 0/O/1/I/L to keep codes readable over the phone.
const SAFE = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
/** 10 chars over 31 symbols ≈ 49 bits: unguessable appointment references. */
export const appointmentCode = customAlphabet(SAFE, 10);
export const giftCardCode = () => {
  const raw = customAlphabet(SAFE, 16)();
  return raw.match(/.{4}/g)!.join("-");
};
export const shortSuffix = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 4);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Booking-link slug for a barber: first name + random suffix. Never derived from the surname
 * or the admin-set display label (which may contain an initial).
 */
export function staffPublicSlug(firstName: string): string {
  return `${slugify(firstName) || "barber"}-${shortSuffix()}`;
}

/** A display label may carry the surname's initial ("Taylor R.") but never the surname itself. */
export function labelContainsSurname(label: string, lastName: string | null | undefined): boolean {
  if (!lastName) return false;
  const s = slugify(lastName);
  if (s.length < 2) return false;
  return slugify(label)
    .split("-")
    .some((part) => part === s || (s.length >= 3 && part.includes(s)));
}

export function slugContainsSurname(slug: string, lastName: string | null | undefined): boolean {
  if (!lastName) return false;
  const s = slugify(lastName);
  return s.length >= 2 && slug.split("-").some((part) => part === s || (s.length >= 3 && part.includes(s)));
}
