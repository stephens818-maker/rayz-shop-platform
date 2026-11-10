/**
 * Block and time off reasons, the pure parts: the default list, validation, keys for new reasons,
 * and what a viewer is shown of a private reason in the calendar, lists and the audit log.
 */
import { describe, expect, it } from "vitest";
import {
  type BlockReason,
  DEFAULT_BLOCK_REASONS,
  NEUTRAL_COLOR,
  NO_PRIVATE,
  forBlocks,
  forTimeOff,
  reasonProblem,
  reasonText,
  redactReasonDetails,
  showReason,
  slugKey,
} from "@/domain/block-reasons";

const list: BlockReason[] = DEFAULT_BLOCK_REASONS.map((r) => ({ ...r, id: `id-${r.key}`, archived: false }));
const map = new Map(list.map((r) => [r.id, r]));
const barber = "staff-barber";
const frontDesk = { staffId: "staff-desk", seesPrivate: false };
const manager = { staffId: "staff-manager", seesPrivate: true };
const doctor = { staffId: barber, reasonId: "id-doctor", reason: "Doctor", note: "Dentist at 2" };
const bank = { staffId: barber, reasonId: "id-bank", reason: "Bank", note: "Deposit run" };

describe("the default list", () => {
  it("has the owner's nine reasons, Emergency for call-ins and the time clock's two, each with its own color", () => {
    expect(DEFAULT_BLOCK_REASONS.map((r) => r.label)).toEqual(["Lunch", "Break", "Bank", "Doctor", "Personal", "Vacation", "Sick", "Emergency", "Training", "Meeting", "Clocked out", "Not in yet"]);
    expect(new Set(DEFAULT_BLOCK_REASONS.map((r) => r.color)).size).toBe(12);
    expect(DEFAULT_BLOCK_REASONS.filter((r) => r.usedFor === "clock").map((r) => r.key)).toEqual(["clocked_out", "not_in"]);
  });

  it("keeps Doctor, Sick and Emergency private, Lunch on the lunch limit and Sick and Emergency free of notice", () => {
    expect(DEFAULT_BLOCK_REASONS.filter((r) => r.private).map((r) => r.key)).toEqual(["doctor", "sick", "emergency"]);
    expect(DEFAULT_BLOCK_REASONS.filter((r) => r.countsAsLunch).map((r) => r.key)).toEqual(["lunch"]);
    expect(DEFAULT_BLOCK_REASONS.filter((r) => r.noticeExempt).map((r) => r.key)).toEqual(["sick", "emergency"]);
  });

  it("offers blocks and time off their own reasons; archived ones neither", () => {
    expect(list.filter(forBlocks).map((r) => r.key)).not.toContain("vacation");
    expect(list.filter(forTimeOff).map((r) => r.key)).toEqual(["doctor", "personal", "vacation", "sick", "emergency", "training"]);
    expect(forBlocks({ usedFor: "both", archived: true })).toBe(false);
  });

  it("keeps the time clock's own reasons out of both pickers", () => {
    expect(list.filter(forBlocks).map((r) => r.key)).not.toContain("clocked_out");
    expect(list.filter(forTimeOff).map((r) => r.key)).not.toContain("not_in");
    expect(forBlocks({ usedFor: "clock", archived: false })).toBe(false);
  });
});

describe("editing the list", () => {
  it("needs a name of up to 30 characters, a #rrggbb color and what it's for", () => {
    expect(reasonProblem({ label: "Kid pickup", color: "#ec4899", usedFor: "blocks" })).toBeNull();
    expect(reasonProblem({ label: "  ", color: "#ec4899", usedFor: "blocks" })).toMatch(/Name/);
    expect(reasonProblem({ label: "x".repeat(31), color: "#ec4899", usedFor: "blocks" })).toMatch(/30/);
    expect(reasonProblem({ label: "Gym", color: "pink", usedFor: "blocks" })).toMatch(/color/);
    expect(reasonProblem({ label: "Gym", color: "#ec4899", usedFor: "lunch" })).toMatch(/blocks, time off or both/);
  });

  it("makes keys from labels", () => {
    expect(slugKey("Kid pickup")).toBe("kid_pickup");
    expect(slugKey("  Café / Bank ")).toBe("cafe_bank");
    expect(slugKey("!!!")).toBe("reason");
  });
});

describe("what a viewer is shown", () => {
  it("a private reason is just Blocked to staff without the permission: no label, note, color or id", () => {
    expect(showReason(doctor, map, frontDesk)).toEqual({ reasonId: null, label: "Blocked", color: NEUTRAL_COLOR, note: null, hidden: true });
    expect(showReason(doctor, map, frontDesk, true).label).toBe("Time off");
    expect(showReason(doctor, map, NO_PRIVATE).hidden).toBe(true);
  });

  it("managers who may see private reasons and the barber themselves see it all", () => {
    for (const v of [manager, { staffId: barber, seesPrivate: false }]) {
      expect(showReason(doctor, map, v)).toEqual({ reasonId: "id-doctor", label: "Doctor", color: "#ef4444", note: "Dentist at 2", hidden: false });
    }
  });

  it("a reason that isn't private shows to everyone with its note", () => {
    expect(showReason(bank, map, frontDesk)).toMatchObject({ label: "Bank", note: "Deposit run", hidden: false });
    expect(reasonText(showReason(bank, map, frontDesk))).toBe("Bank · Deposit run");
  });

  it("a private flag set later hides entries that already have the reason; a rename shows the new name", () => {
    const changed = new Map(map);
    changed.set("id-bank", { ...map.get("id-bank")!, private: true, label: "Errand" });
    expect(showReason(bank, changed, frontDesk).label).toBe("Blocked");
    expect(showReason(bank, changed, manager).label).toBe("Errand");
  });

  it("entries from before the list keep their saved text in the neutral color", () => {
    expect(showReason({ staffId: barber, reasonId: null, reason: "Vacation day", note: null }, map, frontDesk)).toMatchObject({ label: "Vacation day", color: NEUTRAL_COLOR, hidden: false });
  });
});

describe("the audit log", () => {
  const entry = { staffId: barber, reasonId: "id-doctor", reason: "Doctor", note: "Dentist at 2", private: true, startsAt: "x" };

  it("hides a private reason and its note from people who can't see it", () => {
    expect(redactReasonDetails("time_block", entry, frontDesk)).toEqual({ ...entry, reasonId: null, reason: "Blocked", note: null });
    expect(redactReasonDetails("time_off_request", entry, NO_PRIVATE)).toMatchObject({ reason: "Time off", note: null });
  });

  it("leaves it for managers, the barber, and entries that aren't private", () => {
    expect(redactReasonDetails("time_block", entry, manager)).toBe(entry);
    expect(redactReasonDetails("time_block", entry, { staffId: barber, seesPrivate: false })).toBe(entry);
    const open = { ...entry, private: false };
    expect(redactReasonDetails("time_block", open, frontDesk)).toBe(open);
  });
});
