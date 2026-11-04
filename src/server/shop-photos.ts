import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { locationPhotos, staffPhotos } from "@/db/schema";
import { audit } from "./audit";
import { assertShopAccess, can, type StaffContext } from "./auth/staff";
import { AppError, forbidden } from "./errors";

const PHOTO = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;
const MAX = 200_000;

function check(dataUrl: string) {
  if (dataUrl.length > MAX || !PHOTO.test(dataUrl)) throw new AppError("bad_request", "Use a JPEG or PNG under about 150 KB.");
}

export async function saveStaffPhoto(ctx: StaffContext, staffId: string, dataUrl: string) {
  if (staffId !== ctx.staff.id && !can(ctx, "staff.manage")) throw forbidden("You can change your own photo.");
  check(dataUrl);
  await db.insert(staffPhotos).values({ staffId, dataUrl }).onConflictDoUpdate({ target: staffPhotos.staffId, set: { dataUrl, updatedAt: new Date() } });
  await audit(ctx.actor, "staff.photo", "staff", staffId, {}, ctx.currentShopId);
}

export async function saveShopPhoto(ctx: StaffContext, shopId: string, dataUrl: string) {
  assertShopAccess(ctx, shopId);
  if (!can(ctx, "settings.shop") && !can(ctx, "staff.manage") && !can(ctx, "calendar.manage")) throw forbidden("You can't change this shop's photo.");
  check(dataUrl);
  await db
    .insert(locationPhotos)
    .values({ shopId, dataUrl, updatedBy: ctx.staff.id })
    .onConflictDoUpdate({ target: locationPhotos.shopId, set: { dataUrl, updatedBy: ctx.staff.id, updatedAt: new Date() } });
  await audit(ctx.actor, "shop.photo", "shop", shopId, {}, shopId);
}

export async function staffPhotoOf(staffId: string) {
  const [row] = await db.select({ dataUrl: staffPhotos.dataUrl }).from(staffPhotos).where(eq(staffPhotos.staffId, staffId));
  return row?.dataUrl ?? null;
}

export async function shopPhotoOf(shopId: string) {
  const [row] = await db.select({ dataUrl: locationPhotos.dataUrl }).from(locationPhotos).where(eq(locationPhotos.shopId, shopId));
  return row?.dataUrl ?? null;
}
