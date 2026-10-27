# Payroll Report spec

How the platform builds the bi-weekly Payroll Report and the per-shop iSolved timecard files, replacing Charles's payroll workbook. Section numbers follow the original review (§2.1 Total Wages, §3.2 overtime, §6 export), so the findings that refer to them still line up.

**Status:** built. Code in `src/domain/payroll/` (pure math), `src/server/payroll/` (loading, locking, export) and `src/app/admin/payroll/` (pages). Migration `core_0022_payroll`. Tests: `tests/payroll-engine.test.ts`, `tests/payroll-export.test.ts`, `tests/payroll-time-csv.test.ts`, `tests/db/payroll.test.ts`. Workbook problems are in [payroll-workbook-discrepancies.md](payroll-workbook-discrepancies.md).

**No iSolved connection.** There's no API, sync, credentials or automated upload. The only output is a downloadable xlsx per shop, in exactly the workbook's format, which Charles uploads by hand after approve-and-lock (§6.4). The export sits behind a `PayrollExporter` interface so a direct integration can be added later (§10).

**Privacy.** iSolved Employee Numbers live in the database only (`payroll_profiles`), never in the repo, seed or logs. The audit trail records that a number changed, not the number. The pay group letter codes in iSolved aren't stored either; pay group labels default to the shop name and are editable.

## 1. Inputs

| Input | Source on the platform | Workbook equivalent |
| --- | --- | --- |
| Hours worked, training, PTO | `time_entries`: added on Payroll → Hours, or imported from a shift CSV (§1.1). Each entry has a kind: `worked`, `training` or `pto`. | Squire "Hours Worked" feed (column B); training and PTO typed |
| Service $ and product $ | POS tickets rung up at that shop, paid in the period, less refunds issued in it (`payrollSalesBetween`). Service and product net of discounts, no tax, no tips. | Feed column J (card + cash + gift card used) and the product block |
| Tips | All tips on those tickets (card, cash and gift card), less tip refunds | Feed column P |
| Wage, service %, product %, training rate | `payroll_rates`, per person, either for one shop or as their default at every shop. A change applies to periods that aren't locked yet. | Columns C, G, K |
| Employee Number, iSolved name, Key type, row order | `payroll_profiles` | iSolved tab columns A and B |
| Hand-entered values | `payroll_overrides`: a value plus a required reason, per person, shop and period | Cells typed over formulas |

A barber who works at several shops gets one line per shop. Sales and tips land in the shop where the ticket was rung up.

### 1.1 Shift CSV import

Payroll → Hours takes a CSV with a header row. Columns (any order, case-insensitive): employee (Employee Number, iSolved name, display label, "First Last" or "Last, First"), shop (name, slug or pay group label), date (ISO or M/D/YY), start and end (24-hour or AM/PM), and optionally kind and note. An end before the start rolls over to the next day. Every row is checked first; errors are listed by line, and nothing is saved unless the whole file is clean. Entries in a locked period are refused.

## 2. Line math (the Locations sheet)

Each line is computed exactly as the workbook's Locations row, in the same order of operations and in IEEE doubles (the arithmetic Excel uses), so an unrounded value matches the workbook to the last digit. Checked against the workbook: 33 rows, 293 computed cells, 0 mismatches.

| Col | Name | Formula |
| --- | --- | --- |
| B | Hours | worked − OT (regular hours) |
| C | Wage | hourly rate |
| D | Hourly Total | B × C |
| E | Service $ | |
| F | Gross /Hr | E ÷ B (blank where the workbook shows `#DIV/0!`) |
| G | Service % | |
| H | Service commission | E × G |
| I | Service total | H − D |
| J | Product $ | |
| K | Product % | |
| L | Product total | J × K |
| M | NetComm | IF(I > 0, I + L, L). This is the **Comm Sales** export column. |
| N | Total Wages | IF(I > 0, D + I, D) + L, that is max(D, H) + L |
| O | Total % of Gross | N ÷ E |
| P | PTO hours | |
| Q | O.T. hours | after the cross-shop split (§3.2) |
| R | Tips | |
| S | Training hours | |

The platform adds three columns to the right. The export never contains them.

| Col | Name | Formula |
| --- | --- | --- |
| T | O.T. Pay | 1.5 × C × Q (base rate) |
| U | Training Pay | (training rate, or C when there's none) × S, when "Training pay is labor cost" is on; else 0 |
| V | Labor Cost | N + T + U |

### 2.1 What Total Wages leaves out

**Correction to the original §2.1**, which said only the OT *premium* is outside Total Wages. Because D uses regular hours only, the workbook's Total Wages (N), and so its Employee Cost and Gross Profit, leave out **all** OT pay (1.5 × wage × OT hours, not just the 0.5 premium) and **all** training pay. iSolved pays both from the OT and Training hours in the upload.

The platform counts both as labor cost:

- **O.T. Pay** (T) is real labor cost on the report: in each person's and each shop's Labor Cost, in the Locations view, in every total and in the reconciliation gate. It uses the base rate after the cross-shop split, so it follows the same share-of-hours rule as the OT hours. iSolved's "Overtime 1.5" earning is blended OT from its accumulators and includes commission in the regular rate, so the real figure can be higher. The drill-down says "iSolved may compute blended OT higher."
- **Training Pay** (U) is a setting ("Training pay is labor cost on the Payroll Report"), **on** by default. Training is paid at the person's training rate, or at their hourly wage when none is set.
- **Labor Cost** (V) = N + T + U. The Locations view's Employee Cost is Labor Cost, and its Gross Profit is Service − Labor Cost.

The per-employee drill-down shows each piece as a formula with the person's own numbers (for example, "O.T. Pay = 1.5 × $15.50 base rate × 13.09 OT hours = $304.34").

The workbook-shaped columns B to S keep the workbook's own definitions (N is still Total Wages without OT or training), so the report can be compared with the workbook column for column.

## 3. Hours

### 3.1 Days and rounding

Hours are whole hundredths of an hour ("centi-hours"), the precision iSolved uses. Each time entry is split at local midnights in America/Chicago using real elapsed time, so a DST day is 23 or 25 hours long, and an overnight shift counts on both days. Per person, shop and local date, the minutes are added and then rounded half-up to hundredths once. Every later sum and split works in whole hundredths, so the parts always add back up exactly.

### 3.2 Cross-shop overtime (C4)

Ray'z Inc. is one legal company with one FEIN, and each shop is a pay group of it, so overtime is worked out across **all** shops by default.

1. **Workweek:** Sunday 00:00 to Saturday 24:00, America/Chicago.
2. **Basis:** for each person and legal entity (FEIN), add up their worked hours at every shop of that entity in the workweek. Training hours count too only when the C2 setting is on (§3.3). PTO never counts.
3. **OT hours** = basis − 40 (the threshold is a setting), or 0.
4. **Split by share of hours.** The week is cut into slices, one per shop and per pay period that shop's calendar puts those days in. Each slice gets OT in proportion to its share of the week's basis. Shares are rounded to hundredths by largest remainder (ties go to the earlier slice), so the slices add up to the week's OT exactly, and no slice gets more OT than its own hours.
5. **Weeks that span two pay periods**, or two pay calendars (Dubuque's periods start on different Sundays from the other shops'): the whole week is still one week. OT is computed once for the whole week and each period gets its slices' share.
6. **Locked periods keep their OT.** If part of a workweek is in a period that's already approved and locked, those slices keep the OT they were locked with (`payroll_locked_ot`), and only the remainder is shared out among the open slices. A locked file never changes after the fact.
7. **The legal entity** is a field on each pay group (default "Ray'z Inc."). Shops under a different FEIN get their own weekly 40.

Example (tested): 25 h at shop A and 20 h at shop B in one week makes 45 h, so 5 OT hours: 2.78 to A (25/45) and 2.22 to B (20/45). Shop A's file gets 22.22 regular + 2.78 OT; shop B's gets 17.78 + 2.22.

The per-shop export columns don't change; only the hour values do. The Payroll Report shows each person's weekly breakdown (every shop, every week, OT per slice) in the drill-down.

### 3.3 Training and the C2 flag (Q11)

C2 is the "training counts toward overtime" setting: when on, training hours are added to the weekly basis in §3.2. It's **off** until Charles answers Q11. This reading of C2 is mine; the original C2 wording wasn't available.

The workbook exports training hours as their own earning next to regular hours. If the clocked hours already include the training time, it's paid twice. Until Q11 is answered, every line with training hours gets a "training_in_hours" anomaly.

### 3.4 Full time and part time

Full time means averaging **more than** 32 hours a week, so exactly 32.0 is part time. Brand settings, all pending Charles:

| Setting | Default | Options |
| --- | --- | --- |
| Full-time threshold (h/week) | 32 | |
| Hours basis | Clocked worked hours | worked; worked + training; worked + training + PTO |
| Averaging window | Rolling 4 weeks, ending with the period's last week | 1 to 26 weeks |

The status is shown per person in the drill-down with the average it came from. It doesn't change any pay math or the export.

## 4. Pay groups and calendars

Each shop is a pay group with its own pay calendar. Calendars are per pay group, not brand-wide.

| Field | Meaning |
| --- | --- |
| Label | How the pay group is named on screen and in the file name. Defaults to the shop name. |
| Legal entity | The FEIN it belongs to, for §3.2. Default "Ray'z Inc." |
| Export tab | The workbook tab whose layout and formatting the file copies (§6.2). |
| Anchor start, anchor number | A known period's first Sunday and its number |
| Period length | 7 or 14 days, Sunday to Saturday |
| Check offset | Days from the period's last day to the check date (6 = the Friday after) |
| Numbers reset yearly | The first check date in a new year is period 1 |

Current calendars (verified in iSolved, read-only):

| Pay groups | Calendar |
| --- | --- |
| Rock Island, Moline, Utica, Kimberly, Silvis, Coralville, LeClaire | Bi-weekly, Sun–Sat, check the following Friday. Period 23 is 10/18–10/31/2026 (check 11/6); period 24 is 11/1–11/14 (check 11/20). |
| Dubuque | Its own calendar. Period 01 was 10/4–10/17/2026 (check 10/23). |

Because the 12/13–12/26 period's check falls on 1/1/2027, that's period 1 of 2027. Calendars can be edited on Payroll → Setup; once a pay group has locked periods, its calendar can be renumbered but not moved to different dates.

The Payroll Report picks a period by its dates. Pay groups whose calendars share those dates are reported and locked together; Dubuque's periods are separate.

## 5. The Payroll Report

Payroll → Report, for people with `payroll.run` (prepare and download) or `payroll.approve` (lock). Both permissions are brand-only and Brand Admin has them; Brand Owner has everything.

- **Period chips** for recent and upcoming periods, with each pay group's period number and check date.
- **Reconciliation gate** (§7) at the top: either the list of mismatches or a green "every total is the sum of its rows".
- **Locations view:** per shop, Service Sales, Total Wages, O.T. Pay, Training Pay, Employee Cost (= Labor Cost), Gross Profit and Cost %, plus a total row. Every number is the sum of the shop blocks below it.
- **Anomalies** (§8).
- **Per-shop blocks:** columns B to S as in the workbook, then O.T. Pay, Training Pay and Labor Cost highlighted as platform additions, a totals row and a Gross Profit row. Rate columns (C, G, K) are blank on the totals row; Gross /Hr and Total % of Gross are worked out from the totals, not added up.
- **Per-employee drill-down:** the labor cost formula, O.T. Pay with "iSolved may compute blended OT higher.", Training Pay, FT/PT status, the cross-shop weekly breakdown, and the override form.
- **Export preview** per shop: the exact values that will go in the file, unrounded unless the rounding setting is on.
- **Approve and lock** (`payroll.approve`), enabled only when the gate is clear. Download buttons appear once the period is locked.

### 5.1 OT cost layout

O.T. Pay is its own column (T) to the right of the workbook's columns, because it fits there without moving any workbook column. It's also rolled into Labor Cost (V), and the drill-down shows it per person.

## 6. iSolved timecard export

### 6.1 Columns

One file per pay group per period, exactly the workbook's tab: the same columns, headers, order and earning codes.

| Col | Header | Value |
| --- | --- | --- |
| A | Key | iSolved Employee Number |
| B | (blank header) | iSolved name, as typed in the profile (trailing spaces, missing spaces and case kept) |
| C | `E_Regular_Hours` | B, regular hours |
| D | `E_Overtime 1.5_Hours` | Q, OT hours after the cross-shop split. **Hours only.** |
| E | `E_Cash Tips Recd_Dollars` | R, tips |
| F | `E_Comm Sales_Dollars` | M, NetComm |
| G | `E_Ray'z Paid Time_Hours` | P, PTO hours |
| H | `E_Training_Hours` | S, training hours |

- **OT is hours only.** iSolved applies the 1.5× rate itself after upload. The file never contains OT dollars, a premium, O.T. Pay, Training Pay or Labor Cost. A test checks every exported cell against those values.
- **Key cell type is kept.** A Key is written as text (with the `@` format) when the profile says so or when it isn't purely digits (for example, a leading zero); otherwise it's a number, as in the workbook.
- **Cash Tips Recd stays.** In iSolved it's a memo earning: included in gross and taxed, but not paid in the check, which is right when card tips are paid out directly. C3 (moving card tips off it) was declined.
- Rows are in each profile's export position, then by name. A person with no hours, sales or tips in the period isn't listed, unless an override adds them.

### 6.2 Formatting

The file copies the workbook's tab cell for cell: cell types, number formats (General vs `0.00` per cell), fonts (Arial or Roboto 8, per tab), fills, alignment, borders, column widths and zoom. These vary by tab, and the exporter keeps each tab's own.

The formatting lives in `src/server/payroll/isolved-template.json`, generated by `scripts/payroll-template.ts` from the workbook. It holds styles and header text only, no names, Keys or amounts. For each tab it has the header row, each data row position, and the rows after the roster. Rows past the workbook's roster reuse the last data row's styles. A pay group with no tab of its own (Dubuque) uses Rock Island's layout under its own sheet name.

`tests/payroll-export.test.ts` diffs every tab's formatting against the template, not just the values. Locally, `scripts/payroll-golden.ts <workbook>` regenerates all seven tabs from the workbook's own rows and diffs them cell by cell against the original: 0 differences in values, types or formatting.

### 6.3 Rounding

Values go out **unrounded**, exactly as the workbook has them (for example 79.9399999999999, or a NetComm of 224.433). iSolved's Timecard Import has "Implied Decimal Places" set to None by default, so it takes them as they are.

A brand setting rounds export values to 2 decimals half-up instead. It's **off**, pending Charles. Half-up works from the decimal value, not the binary float, and never uses banker's rounding: 6.315 becomes 6.32, and 2.675 becomes 2.68. On the sample data it changes 19 cells (18 NetComm and one hours value), and the total NetComm by under $0.03. The report and the gate use the same values as the file, so turning it on can't create a mismatch.

### 6.4 Upload (by hand)

1. Prepare the period and clear the reconciliation gate.
2. Approve and lock (`payroll.approve`).
3. Download each pay group's file (`payroll.run`). The file name is `<tab> - period NN (start to end).xlsx`.
4. In iSolved: Timecard Import (Excel/CSV), pick that pay group, upload.

Downloads are only for locked periods. They're served from the locked snapshot, not recomputed, so a file can't change after approval. Each download is audited.

## 7. Reconciliation gate

Approve-and-lock is blocked while there's any mismatch, compared to the cent (more than $0.00 or 0.00 hours). Each mismatch is listed on screen with the shop, column, the two numbers and what didn't match.

| Check | What's compared |
| --- | --- |
| Rows | Each shop's total for every summed column (hours, money, O.T. Pay, Training Pay, Labor Cost) against the sum of its lines |
| Export | Each export column's sum against the report total it comes from (for example, Comm Sales against NetComm), and the export's row count against the report's |
| Locations | Each Locations total against the sum of the shops |

Totals are always computed from line items, so a mismatch means a bug; the gate is the guard that keeps a wrong file from being locked. Locked periods rerun the gate on the snapshot when they're shown.

## 8. Anomalies

Anomalies never block the lock. They list what a person should look at before approving.

| Kind | When |
| --- | --- |
| `owner_case` | Hours at $0.00 labor cost (owner or salaried?). Q17. |
| `sales_without_hours` | Service sales with no hours: a missed clock-in, or an owner (Q17). |
| `netcomm_gap` | NetComm typed over the formula, so the report's Total Wages and the export's Comm Sales disagree. Q17. |
| `override` | Any hand-entered value, with its reason |
| `missing_key` | No iSolved Employee Number yet |
| `training_in_hours` | Training hours while Q11 is open (§3.3) |
| `no_rate` | Sales but no wage and no commission rate |
| `missed_punch` | A clock-out with no clock-in, no clock-out, or a clock-in again without clocking out, in the period. That shift has no hours until a manager fixes the punch. |
| `timesheet_not_approved` | A timesheet with hours or missed punches that no manager has approved |
| `hours_not_locked` | The shop's timesheets aren't locked for the period. Only listed when **Hours come from the time clock** is off; when it's on, this blocks the lock (§9). |
| `sales_day_without_hours` | Service sales on a day with no hours at that shop, for someone who has hours in the period (a missed clock-in?) |
| `hours_not_from_clock` | Worked hours typed in or imported rather than clocked (while hours come from the clock) |

The time clock's flags cover shops not yet locked; a locked shop is history.

The two workbook cases waiting on Q17 (the Coralville NetComm typed $123.46 above its formula, and the Moline owner row with 80 hours at $0 cost and $20 of service sales) are flagged and left exactly as entered. Nothing is guessed.

## 9. Approve and lock

- Locking takes the period's dates and locks every pay group whose calendar has that period, in one transaction.
- **Hours come from the time clock** (a payroll setting, on by default; Charles decided the basic clock ships at launch): locking is refused until every shop's timesheets are locked for each day of the period. A shop's timesheets lock (Payroll → Timesheets) only after the period ends and every timesheet with hours or missed punches is approved by a manager, which in turn needs the missed punches fixed. The refusal names the shops and the timesheets still waiting.
- It stores a snapshot per pay group: the shop block, lines, totals and export rows, plus the OT each slice was given (`payroll_locked_ot`).
- After locking, time entries and overrides in the period are refused, and the report shows the snapshot.
- Each pay group's lock is audited.

## 10. Future: direct iSolved integration

Not built, and not planned for now. The export goes through one interface, so an integration can be added without touching the payroll math:

```ts
interface PayrollExporter {
  id: string;
  label: string;
  contentType: string;
  fileName(f: ExportFile): string;
  render(f: ExportFile): Promise<Buffer>;
}
```

`ExportFile` carries the tab, pay group, period number and dates, and the locked export rows. Today `EXPORTERS` has one entry, the iSolved timecard xlsx. A later integration would be another exporter (or a sibling that sends instead of rendering) fed the same locked rows.

## 11. Settings

Payroll → Setup (`payroll.run`).

| Setting | Default | Status |
| --- | --- | --- |
| OT threshold | 40 h per workweek | |
| OT multiplier (for O.T. Pay on the report only) | 1.5 | |
| Training counts toward OT (C2) | Off | Pending Q11 |
| Training pay is labor cost | On | |
| Round export to 2 decimals, half-up | Off | Pending Charles |
| Full-time threshold, hours basis, window | 32 h; clocked worked hours; rolling 4 weeks | Pending Charles |

Per pay group: label, legal entity, export tab and calendar (§4). Per person: Employee Number, iSolved name, Key as text, export position, and rates per shop.

## 12. Golden files

The golden files from the original review aren't in this repo (they hold real data). `scripts/payroll-golden.ts <workbook> --write <dir>` regenerates them into a folder outside the repo, with Testing Bot's fixes:

- `expected_isolved_export.xlsx` copies each tab's own formatting (the text Key keeps `@`, number formats aren't forced to `0.00`, each tab's fills and fonts are kept).
- `golden_locations_calc.csv`:
  - `feed_hours` is the feed's own value, blank when the person isn't in the feed. Total hours is a separate `total_hours` column (B + Q).
  - `manual_*` columns flag every typed cell (hours, hourly total, service, commission, service total, product total, NetComm, Total Wages, tips).
  - Blank instead of the text `#DIV/0!`.

The script refuses a `--write` path inside the repo.

## 13. Declined and open

| Item | Status |
| --- | --- |
| C1 blended-rate OT | **Declined by Charles: keep iSolved as-is.** iSolved computes blended OT itself. |
| C3 moving card tips off Cash Tips Recd | **Declined by Charles: keep iSolved as-is.** |
| Q11 training inside clocked hours | Open. C2 off; training flagged. |
| Q16 Dubuque export | Resolved: Dubuque has its own pay calendar and its own file in the same format. |
| Q17 owner row and the Coralville NetComm gap | Open. Flagged, not fixed. |
| FT/PT basis and window, 2-decimal rounding | Pending Charles; defaults above. |
