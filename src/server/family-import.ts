import "server-only";
import { and, eq, inArray, isNull } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db";
import { customerSquireIds, customers } from "@/db/schema";
import {
  FamilyRow,
  familyColumns,
  hasFamilyColumns,
  parseChild,
  planFamilies,
} from "@/domain/family-import";
import { normalizePhone } from "@/lib/phone";
import { localDateOf, todayLocal } from "@/lib/time";
import { Actor } from "./audit";
import { attachChild } from "./family";
import { mapHeaders, parseSquireDateTime } from "./importer";

export interface FamilyImportResult {
  /** The file's columns the family links came from. */
  columns: string[];
  linked: number;
  alreadyLinked: number;
  problems: { line: number; message: string }[];
}

/**
 * After a clients import: put each Squire kid record on its parent's family account, when the file
 * says who the parent is. Kids already under that parent are left alone; anything the file can't
 * settle (no parent row, the parent not on file, over the brand's limit) is listed for the
 * duplicates page. A dry run only reads the file (its clients aren't saved yet): how many links it
 * states. Returns null when the file has no family columns.
 */
export async function importFamilies(
  csv: string,
  opts: { dryRun: boolean; actor: Actor; now?: Date },
): Promise<FamilyImportResult | null> {
  const parsed = Papa.parse<Record<string, string>>(
    csv.replace(/^\uFEFF/, ""),
    { header: true, skipEmptyLines: "greedy" },
  );
  const headers = parsed.meta.fields ?? [];
  const cols = familyColumns(headers);
  if (!hasFamilyColumns(cols)) return null;
  const base = mapHeaders(headers, "clients");
  const cell = (r: Record<string, string>, h: string | undefined) =>
    h ? r[h]?.trim() || undefined : undefined;
  const rows: FamilyRow[] = parsed.data.map((r, i) => ({
    line: i + 2,
    squireId: cell(r, base.squireId) ?? null,
    name:
      [cell(r, base.firstName), cell(r, base.lastName)]
        .filter(Boolean)
        .join(" ") ||
      cell(r, base.fullName) ||
      "This client",
    parentId: cell(r, cols.parentId) ?? null,
    parentPhone: cell(r, cols.parentPhone) ?? null,
    familyId: cell(r, cols.familyId) ?? null,
    isChild: parseChild(cell(r, cols.isChild)),
  }));
  const birthdays = new Map(
    parsed.data.map(
      (r, i) => [rows[i].squireId, cell(r, cols.birthday)] as const,
    ),
  );
  const plan = planFamilies(rows);
  const result: FamilyImportResult = {
    columns: Object.values(cols).filter((x): x is string => !!x),
    linked: 0,
    alreadyLinked: 0,
    problems: [...plan.problems],
  };
  if (!plan.links.length) return result;
  if (opts.dryRun) return { ...result, linked: plan.links.length };

  const now = opts.now ?? new Date();
  const touched = new Set<string>();
  await db.transaction(async (tx) => {
    const squireIds = [
      ...new Set(
        plan.links.flatMap((l) => [
          l.childSquireId,
          ...("squireId" in l.parent ? [l.parent.squireId] : []),
        ]),
      ),
    ];
    const owners = new Map(
      (
        await tx
          .select({
            squireId: customerSquireIds.squireId,
            customerId: customerSquireIds.customerId,
          })
          .from(customerSquireIds)
          .where(inArray(customerSquireIds.squireId, squireIds))
      ).map((r) => [r.squireId, r.customerId]),
    );
    for (const l of plan.links) {
      const childId = owners.get(l.childSquireId);
      if (!childId) {
        result.problems.push({
          line: l.line,
          message: `Squire client ${l.childSquireId} isn't on file: import the clients file first.`,
        });
        continue;
      }
      let parentId: string | null = null;
      if ("squireId" in l.parent) {
        parentId = owners.get(l.parent.squireId) ?? null;
        if (!parentId)
          result.problems.push({
            line: l.line,
            message: `Their parent (Squire client ${l.parent.squireId}) isn't on file.`,
          });
      } else {
        const phone = normalizePhone(l.parent.phone);
        const hits = phone
          ? await tx
              .select({ id: customers.id })
              .from(customers)
              .where(
                and(eq(customers.phone, phone), isNull(customers.guardianId)),
              )
              .limit(2)
          : [];
        if (hits.length === 1) parentId = hits[0].id;
        else
          result.problems.push({
            line: l.line,
            message: hits.length
              ? "More than one client has the parent's phone: attach them from the duplicates page."
              : "No client on file has the parent's phone.",
          });
      }
      if (!parentId || parentId === childId) continue;
      try {
        const r = await tx.transaction((sp) =>
          attachChild(parentId!, childId, opts.actor, { tx: sp }),
        );
        if (r.attached) result.linked++;
        else result.alreadyLinked++;
        touched.add(parentId);
        touched.add(childId);
      } catch (e) {
        result.problems.push({ line: l.line, message: (e as Error).message });
        continue;
      }
      const raw = birthdays.get(l.childSquireId);
      const when = raw ? parseSquireDateTime(raw) : null;
      const day = when ? localDateOf(when) : null;
      if (day && day <= todayLocal(now)) {
        await tx
          .update(customers)
          .set({ birthday: day, birthYear: Number(day.slice(0, 4)) })
          .where(and(eq(customers.id, childId), isNull(customers.birthday)));
      }
    }
  });
  if (touched.size) {
    await import("./badges")
      .then((b) => b.refreshBadges([...touched], now))
      .catch((err: Error) =>
        console.error(
          "badge refresh after the family import failed",
          err.message,
        ),
      );
  }
  return result;
}
