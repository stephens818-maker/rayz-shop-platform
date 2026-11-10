"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { LocationProfileForm } from "@/domain/location-profile";
import { SHOP_PART_PERMISSION, type Permission } from "@/domain/permissions";
import { safe } from "@/server/action";
import { assertShopAccess, authorize } from "@/server/auth/staff";
import { addressDetails, geocodeAddress, suggestAddresses } from "@/server/geo";
import { addShopPhoto, moveShopPhoto, removeShopPhoto, saveLocationProfile } from "@/server/location-profile";

/** Editing a location's details, or setting up a new location in the wizard (which looks addresses up too). */
const DETAILS: Permission[] = ["settings.shop", SHOP_PART_PERMISSION.details];
const LOOKUP: Permission[] = [...DETAILS, "locations.setup"];

const Token = z.string().trim().max(64).nullable().default(null);
const Parts = z.object({
  address: z.string().trim().max(120),
  address2: z.string().trim().max(80).default(""),
  city: z.string().trim().max(60),
  state: z.string().trim().max(2),
  zip: z.string().trim().max(10),
});

export async function saveLocationProfileAction(shopId: string, raw: LocationProfileForm) {
  return safe(async () => {
    const ctx = await authorize(DETAILS);
    const r = await saveLocationProfile(ctx, shopId, raw);
    revalidatePath("/admin/settings");
    return r;
  });
}

/** Suggestions while typing the street address. */
export async function addressSuggestionsAction(input: string, sessionToken: string | null) {
  return safe(async () => {
    await authorize(LOOKUP);
    const q = z.string().trim().max(200).parse(input);
    if (q.length < 3) return [];
    return suggestAddresses(q, Token.parse(sessionToken));
  });
}

/** The picked suggestion's parts, pin and Place ID. Ends the autocomplete session. */
export async function addressDetailsAction(placeId: string, sessionToken: string | null) {
  return safe(async () => {
    await authorize(LOOKUP);
    return addressDetails(z.string().trim().min(1).max(512).parse(placeId), Token.parse(sessionToken));
  });
}

/** A pin for what's typed, before saving ("Find on map"). */
export async function geocodeAddressAction(raw: z.input<typeof Parts>) {
  return safe(async () => {
    await authorize(LOOKUP);
    return geocodeAddress(Parts.parse(raw));
  });
}

export async function addShopPhotoAction(shopId: string, input: { kind: "photo" | "logo"; dataUrl: string; alt?: string | null }) {
  return safe(async () => {
    const ctx = await authorize(DETAILS);
    assertShopAccess(ctx, shopId);
    const r = await addShopPhoto(ctx, shopId, input);
    revalidatePath("/admin/settings");
    return r;
  });
}

export async function removeShopPhotoAction(photoId: string) {
  return safe(async () => {
    const ctx = await authorize(DETAILS);
    const r = await removeShopPhoto(ctx, z.uuid().parse(photoId));
    revalidatePath("/admin/settings");
    return r;
  });
}

export async function moveShopPhotoAction(photoId: string, dir: -1 | 1) {
  return safe(async () => {
    const ctx = await authorize(DETAILS);
    const r = await moveShopPhoto(ctx, z.uuid().parse(photoId), dir === -1 ? -1 : 1);
    revalidatePath("/admin/settings");
    return r;
  });
}
