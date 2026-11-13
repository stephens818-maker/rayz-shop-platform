import "server-only";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { staff, staffChannelMembers, staffChannels, staffMessages, staffShops } from "@/db/schema";
import { staffChatBody } from "@/domain/staff-chat";
import { audit } from "./audit";
import { can, type StaffContext } from "./auth/staff";
import { AppError, forbidden, notFound } from "./errors";

const manager = (ctx: StaffContext) => can(ctx, "staff.manage") || can(ctx, "settings.brand");

async function ensureShop(shopId: string) {
  const [row] = await db.insert(staffChannels).values({ kind: "shop", shopId }).onConflictDoNothing().returning();
  if (row) return row;
  const [existing] = await db.select().from(staffChannels).where(and(eq(staffChannels.kind, "shop"), eq(staffChannels.shopId, shopId)));
  return existing;
}

async function ensureBrand() {
  const [row] = await db.insert(staffChannels).values({ kind: "brand" }).onConflictDoNothing().returning();
  if (row) return row;
  const [existing] = await db.select().from(staffChannels).where(eq(staffChannels.kind, "brand"));
  return existing;
}

async function join(channelId: string, staffId: string) {
  await db.insert(staffChannelMembers).values({ channelId, staffId }).onConflictDoNothing();
}

export async function staffChatFor(ctx: StaffContext) {
  const shops = ctx.shops.filter((s) => ctx.shopIds.includes(s.id) || ctx.brandWide);
  const channels = [];
  for (const shop of shops) {
    const ch = await ensureShop(shop.id);
    if (!ch) continue;
    await join(ch.id, ctx.staff.id);
    channels.push({ id: ch.id, kind: "shop" as const, title: shop.name, canPost: true });
  }
  const brand = await ensureBrand();
  if (brand) {
    await join(brand.id, ctx.staff.id);
    channels.push({ id: brand.id, kind: "brand" as const, title: "All shops", canPost: manager(ctx) });
  }
  const dms = await db
    .select({ id: staffChannels.id })
    .from(staffChannels)
    .innerJoin(staffChannelMembers, eq(staffChannelMembers.channelId, staffChannels.id))
    .where(and(eq(staffChannels.kind, "dm"), eq(staffChannelMembers.staffId, ctx.staff.id)));
  for (const dm of dms) {
    const others = await db
      .select({ label: staff.displayLabel })
      .from(staffChannelMembers)
      .innerJoin(staff, eq(staff.id, staffChannelMembers.staffId))
      .where(and(eq(staffChannelMembers.channelId, dm.id), sql`${staff.id} <> ${ctx.staff.id}`));
    channels.push({ id: dm.id, kind: "dm" as const, title: others.map((o) => o.label).join(", ") || "Direct message", canPost: true });
  }
  const people = ctx.shopIds.length
    ? await db
        .selectDistinct({ id: staff.id, label: staff.displayLabel })
        .from(staff)
        .innerJoin(staffShops, eq(staffShops.staffId, staff.id))
        .where(and(eq(staff.active, true), eq(staff.kind, "person"), inArray(staffShops.shopId, ctx.shopIds), sql`${staff.id} <> ${ctx.staff.id}`))
        .orderBy(asc(staff.displayLabel))
        .limit(80)
    : [];
  return { channels, people, canModerate: manager(ctx) };
}

async function readable(ctx: StaffContext, channelId: string) {
  const [ch] = await db.select().from(staffChannels).where(eq(staffChannels.id, channelId));
  if (!ch) throw notFound("Channel");
  const [member] = await db
    .select({ staffId: staffChannelMembers.staffId })
    .from(staffChannelMembers)
    .where(and(eq(staffChannelMembers.channelId, channelId), eq(staffChannelMembers.staffId, ctx.staff.id)));
  if (!member && !(ch.kind === "brand" && manager(ctx))) throw forbidden("That chat isn't one of yours");
  return ch;
}

export async function staffMessagesFor(ctx: StaffContext, channelId: string) {
  const ch = await readable(ctx, channelId);
  const rows = await db
    .select({
      id: staffMessages.id,
      body: staffMessages.body,
      at: staffMessages.createdAt,
      author: staff.displayLabel,
      mine: sql<boolean>`${staffMessages.authorId} = ${ctx.staff.id}`,
      deletedAt: staffMessages.deletedAt,
      reportedAt: staffMessages.reportedAt,
    })
    .from(staffMessages)
    .innerJoin(staff, eq(staff.id, staffMessages.authorId))
    .where(eq(staffMessages.channelId, channelId))
    .orderBy(desc(staffMessages.createdAt))
    .limit(80);
  const seeRemoved = manager(ctx);
  return {
    canPost: ch.kind === "brand" ? manager(ctx) : true,
    messages: rows
      .filter((r) => seeRemoved || !r.deletedAt)
      .reverse()
      .map((r) => ({
        id: r.id,
        body: r.deletedAt ? "Removed" : r.body,
        at: r.at.toISOString(),
        author: r.author,
        mine: r.mine,
        reported: !!r.reportedAt,
      })),
  };
}

export async function postStaffChat(ctx: StaffContext, channelId: string, raw: string) {
  const ch = await readable(ctx, channelId);
  if (ch.kind === "brand" && !manager(ctx)) throw forbidden("A manager posts in the all-shops channel");
  const body = staffChatBody(raw);
  if (!body) throw new AppError("bad_request", "Write a message");
  await db.insert(staffMessages).values({ channelId, authorId: ctx.staff.id, body });
}

export async function openDirectMessage(ctx: StaffContext, otherId: string) {
  if (otherId === ctx.staff.id) throw new AppError("bad_request", "Pick someone else");
  const [other] = await db.select({ id: staff.id, label: staff.displayLabel }).from(staff).where(and(eq(staff.id, otherId), eq(staff.active, true)));
  if (!other) throw notFound("Person");
  const mine = await db
    .select({ id: staffChannels.id })
    .from(staffChannels)
    .innerJoin(staffChannelMembers, eq(staffChannelMembers.channelId, staffChannels.id))
    .where(and(eq(staffChannels.kind, "dm"), eq(staffChannelMembers.staffId, ctx.staff.id)));
  for (const ch of mine) {
    const [hit] = await db
      .select({ staffId: staffChannelMembers.staffId })
      .from(staffChannelMembers)
      .where(and(eq(staffChannelMembers.channelId, ch.id), eq(staffChannelMembers.staffId, otherId)));
    if (hit) return ch.id;
  }
  const [created] = await db.insert(staffChannels).values({ kind: "dm" }).returning();
  await join(created.id, ctx.staff.id);
  await join(created.id, otherId);
  return created.id;
}

export async function deleteOwnStaffMessage(ctx: StaffContext, messageId: string) {
  const [row] = await db.select().from(staffMessages).where(eq(staffMessages.id, messageId));
  if (!row) throw notFound("Message");
  if (row.authorId !== ctx.staff.id) throw forbidden("You can delete your own messages");
  await readable(ctx, row.channelId);
  await db.update(staffMessages).set({ deletedAt: new Date() }).where(and(eq(staffMessages.id, messageId), isNull(staffMessages.deletedAt)));
  await audit(ctx.actor, "staff_chat.delete", "staff_message", messageId, { own: true }, ctx.currentShopId);
}

export async function moderateStaffMessage(ctx: StaffContext, messageId: string, action: "delete" | "report") {
  if (!manager(ctx)) throw forbidden("A manager removes or reports a message");
  const [row] = await db.select().from(staffMessages).where(eq(staffMessages.id, messageId));
  if (!row) throw notFound("Message");
  await readable(ctx, row.channelId);
  await db
    .update(staffMessages)
    .set(action === "delete" ? { deletedAt: new Date() } : { reportedAt: new Date() })
    .where(and(eq(staffMessages.id, messageId), action === "delete" ? isNull(staffMessages.deletedAt) : undefined));
  await audit(ctx.actor, action === "delete" ? "staff_chat.delete" : "staff_chat.report", "staff_message", messageId, {}, ctx.currentShopId);
}
