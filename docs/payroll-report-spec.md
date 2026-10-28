# Payroll Report spec

How the platform builds the bi-weekly Payroll Report and the per-shop iSolved timecard files, replacing Charles's payroll workbook. Section numbers follow the original review (§2.1 Total Wages, §3.2 overtime, §6 export), so the findings that refer to them still line up.

**Status:** built. Code in `src/domain/payroll/` (pure math), `src/server/payroll/` (loading, locking, export) and `src/app/admin/payroll/` (pages). The Payroll Report page is `src/app/admin/reports/payroll/report/`. Migrations `core_0022_payroll`, `core_0128_payroll_approvals`, `core_0129_pay_calendar`, `core_0130_payroll_commission_adjustments` and `core_0134_rollout` (§1.2). Tests: `tests/squire-commissions.test.ts`, `tests/db/rollout.test.ts`, `tests/payroll-engine.test.ts`, `tests/payroll-independent.test.ts` (hand-worked numbers from punches and pay-plan versions, not from the workbook), `tests/payroll-review.test.ts`, `tests/payroll-privacy.test.ts`, `tests/payroll-export.test.ts`, `tests/payroll-golden.test.ts` (all 33 golden rows and the iSolved file, cell for cell), `tests/payroll-time-csv.test.ts`, `tests/db/payroll.test.ts`, `tests/db/payroll-approval.test.ts`, `tests/db/payroll-reports.test.ts`, `tests/db/pay-calendar.test.ts`. Workbook problems are in [payroll-workbook-discrepancies.md](payroll-workbook-discrepancies.md).

**No iSolved connection.** There's no API, sync, credentials or automated upload. The only output is a downloadable xlsx per shop, in exactly the workbook's format, which Charles uploads by hand after approve-and-lock (§6.4). The export sits behind a `PayrollExporter` interface so a direct integration can be added later (§10).

**Privacy.** iSolved Employee Numbers live in the database only (`payroll_profiles`), never in the repo, seed or logs. The audit trail records that a number changed, not the number. iSolved's pay group letter codes (B is Rock Island, C is Moline) are stored per pay group; they aren't sensitive. Pay group labels default to the shop name and are editable.

## 1. Inputs

| Input | Source on the platform | Workbook equivalent |
| --- | --- | --- |
| Hours worked, training, PTO | `time_entries`: added on Payroll → Hours, or imported from a shift CSV (§1.1). Each entry has a kind: `worked`, `training` or `pto`. | Squire "Hours Worked" feed (column B); training and PTO typed |
| Service $ and product $ | POS tickets rung up at that shop, paid in the period, less refunds issued in it (`payrollSalesBetween`). Service and product net of discounts, no tax, no tips. | Feed column J (card + cash + gift card used) and the product block |
| Tips | All tips on those tickets (card, cash and gift card), less tip refunds. Sales imported from Squire (`is_imported`, or a `squire_import` payment) are left out of sales, refunds and tips (C5): Squire paid those already. | Feed column P |
| Sales tax | Tax on the employee's tickets (service and product, less refunds). Reference only: shown on the report, never used in pay math or the export. | Feed column R |
| Wage, service %, product %, training rate | `payroll_rates`, per person, either for one shop or as their default at every shop. A change applies to periods that aren't locked yet. With compensation plans driving payroll, rates are effective-dated instead (§11). | Columns C, G, K |
| Employee Number, iSolved name, Key type, row order | `payroll_profiles` | iSolved tab columns A and B |
| Hand-entered values | `payroll_overrides`: a value plus a required reason, per person, shop and period | Cells typed over formulas |

A barber who works at several shops gets one line per shop. Sales and tips land in the shop where the ticket was rung up. Sales on a ticket with no employee are shown under the shop's block as unassigned sales and flagged (`unassigned_sales`, §8); nobody is credited for them.

### 1.1 Shift CSV import

Payroll → Hours takes a CSV with a header row. Columns (any order, case-insensitive): employee (Employee Number, iSolved name, display label, "First Last" or "Last, First"), shop (name, slug or pay group label), date (ISO or M/D/YY), start and end (24-hour or AM/PM), and optionally kind and note. An end before the start rolls over to the next day. Every row is checked first; errors are listed by line, and nothing is saved unless the whole file is clean. Entries in a locked period are refused.

### 1.2 Shops still on Squire (the rollout)

During the rollout ([rollout-runbook.md](rollout-runbook.md), migration `core_0134_rollout`), each shop's payroll for a pay period comes from one place. With no `shop_rollouts` row anywhere, every shop is on the platform, as above. Once any shop has one, a shop is on the platform from its **Payroll from here starting** period on, and on Squire data before it (or with no date). A locked period keeps the source it was locked with.

For a shop on Squire data, the inputs above are replaced by Squire's **Commissions** report for that shop and period, imported on **Setup → Rollout** (`payroll_squire_imports`, one per shop and period, and `payroll_squire_inputs`, one per person):

| Input | From Squire's report |
| --- | --- |
| Hours worked | The service block's Hours Worked (OT included). Squire's report has no OT, PTO or training hours: they're typed on the report with a reason, or read from OT, PTO and Training columns if they're added to the file. |
| Service $ and product $ | Each block's Total |
| Tips | The service block's Tips (or its Squire, POS and Gift Card tips added up). All of it is `E_Cash Tips Recd`: Squire paid the card tips, so nothing is paid out or charged here. |
| Sales tax | Each block's Tax, reference only |
| Unassigned sales | The report's Unassigned row |

The shop's punches, tickets and declared tips for the period are left out, and it isn't checked for locked timesheets or for the tip tie-out. Names match the Staff page's Squire name, then the display or full name, then a first name only one person at the shop has; a line that matches nobody, or more than one, saves nothing. Approve is refused while a shop on Squire data has no import for the period. Everything else (rates, the line math, OT, the export, approve and lock) is the same for every shop.

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
| U | Training Pay | training rate × S (§3.3): their Staff page's rate in effect each day, else Payroll setup's, else C (flagged) |
| V | Labor Cost | N + T + U + any guarantee top-up + the regular-rate OT premium owed (§3.4) |

### 2.1 What Total Wages leaves out

**Correction to the original §2.1**, which said only the OT *premium* is outside Total Wages. Because D uses regular hours only, the workbook's Total Wages (N), and so its Employee Cost and Gross Profit, leave out **all** OT pay (1.5 × wage × OT hours, not just the 0.5 premium) and **all** training pay. iSolved pays both from the OT and Training hours in the upload.

The platform counts both as labor cost:

- **O.T. Pay** (T) is real labor cost on the report: in each person's and each shop's Labor Cost, in the Locations view, in every total and in the reconciliation gate. It uses the base rate after the cross-shop split, so it follows the same share-of-hours rule as the OT hours. iSolved's "Overtime 1.5" earning is blended OT from its accumulators and includes commission in the regular rate, so the real figure can be higher. The drill-down says "iSolved may compute blended OT higher."
- **Training Pay** (U) is real labor cost too (Charles, Oct 28; the earlier "Training pay is labor cost" setting is gone): training hours × the person's own flat training rate, its own line outside the greater-of (§3.3). It's in each person's and each shop's Labor Cost, the Locations view, every total and the reconciliation gate. Periods locked before this keep their figures, with training pay left out of their Labor Cost.
- **Labor Cost** (V) = N + T + U, plus the regular-rate OT premium commission adds (§3.4). The Locations view's Employee Cost is Labor Cost, and its Gross Profit is Service − Labor Cost.

The per-employee drill-down shows each piece as a formula with the person's own numbers (for example, "O.T. Pay = 1.5 × $14.50 base rate × 6.40 OT hours = $139.20").

The workbook-shaped columns B to S keep the workbook's own definitions (N is still Total Wages without OT or training), so the report can be compared with the workbook column for column.

**Business rule (N10): the greater-of uses regular hours only.** D and F use B (worked − OT) and leave training out, so commission tops up over regular pay alone. That's in the employee's favor and is how the workbook works; don't "fix" it to total hours. Tips are never in the greater-of, the top-up, Total Wages or the regular rate (I1; a test checks it). Minimum wage is checked per period against straight-time pay, never counting tips, and no tip credit is taken toward minimum wage (the 45B FICA credit is a separate report).

### 2.2 Refunds, card surcharge and loyalty in the commission base (I4, I10)

- **Refunds come off first.** A refund counts in the period it's issued, at the rate the original sale earned (§11), and lowers that period's Service $ (E) or Product $ (J) **before** the greater-of in N. If refunds are bigger than the period's sales, commission (H or L) is $0.00, never negative, and the rest is written off: the shop absorbs it, it's never taken from a later check, and the line gets a `refund_written_off` anomaly with the amount.
- **Card surcharge** (Payroll setup → Commission base). Default: left out of the sale commission is paid on, because the surcharge is the shop's (today's behavior). Option: part of it. When included, a ticket's surcharge is split between service and product by their net.
- **Loyalty rewards.** Default: a redeemed reward comes off the sale commission is paid on (today's behavior). Option: the shop absorbs it, so commission is paid on the price before the reward. The reward is split between service and product by gross. Pending Charles (Q15).

### 2.3 Late commission for a locked period (I2)

A locked period never changes. Commission found later for a locked period (a missed ticket, a fixed rate) is paid in the next open period instead: Payroll → Report → the person's drill-down → "Late commission", with the earned dates (a locked, earlier period), the amount and a required reason. It's stored in `payroll_commission_adjustments`, audited (`payroll.late_commission`, `payroll.late_commission_remove`), added to this period's NetComm (M, so the Comm Sales column) and Total Wages, and flagged (`late_commission`).

If the earned period had overtime, the late commission raises that period's regular rate too, so half-time is owed on it: retro OT = 0.5 × the locked OT hours × the amount ÷ the locked hours worked, from the locked snapshot. It's in this period's Labor Cost and shown in the anomaly, to enter in iSolved by hand (§3.4).

## 3. Hours

### 3.1 Days and rounding

Hours are whole hundredths of an hour ("centi-hours"), the precision iSolved uses. Each time entry is split at local midnights in America/Chicago using real elapsed time, so a DST day is 23 or 25 hours long, and an overnight shift counts on both days. Per person, shop and local date, the minutes are added and then rounded half-up to hundredths once. Every later sum and split works in whole hundredths, so the parts always add back up exactly.

On screen, hours read decimal like the workbook (`78.25`) or as hours and minutes (`78h 15m`), per the **Payroll hours** setting (decimal by default, until Charles's spec says otherwise). The math, the CSV downloads and the iSolved file always use decimal hours. Clock times read 12-hour (`9:05 AM`) unless the brand picks 24-hour.

### 3.2 Cross-shop overtime (C4)

Ray'z Inc. is one legal company with one FEIN, and each shop is a pay group of it, so overtime is worked out across **all** shops by default.

1. **Workweek:** Sunday 00:00 to Saturday 24:00, America/Chicago.
2. **Basis:** for each person and legal entity (FEIN), add up their worked hours at every shop of that entity in the workweek. Training on top of clocked hours counts too (C2, a setting, on by default, §3.3). PTO never counts.
3. **OT hours** = basis − 40 (the threshold is a setting), or 0.
4. **Split by share of hours.** The week is cut into slices, one per shop and per pay period that shop's calendar puts those days in. Within one pay period, each slice gets that period's OT in proportion to its share of the period's basis (when the whole week is in one period, that's its share of the week's). Shares are rounded to hundredths by largest remainder (ties go to the earlier slice), so the slices add up to the week's OT exactly, and no slice gets more OT than its own hours.
5. **Weeks that span two pay periods**, or two pay calendars (Dubuque's periods start on different Sundays from the other shops', or a workweek start that isn't the period's): the whole week is still one week, and OT is computed once for it. **The OT goes to the period that holds the hours past the 40th**, in date order: day by day through the week, a day's OT is the part of it beyond 40, shared by hours among that day's slices. Within one period, its OT is shared among its shops by hours as in 4. So 24 h before a period boundary and 20 h after it put all 4.00 OT hours in the later period (PY-OT-03). Hours belong to the period of the day worked.
6. **Locked periods keep their OT.** If part of a workweek is in a period that's already approved and locked, those slices keep the OT they were locked with (`payroll_locked_ot`), and the open period takes the difference as an adjustment, up to its own hours. A locked file never changes after the fact.
7. **The legal entity** is a field on each pay group (default "Ray'z Inc.", which iSolved reports as one entity). Shops under a different FEIN get their own weekly 40.
8. **From punches.** Worked hours are the closed shifts' paid time (unpaid breaks and any automatic meal taken out), by real elapsed time. Overtime is always worked out from them; nobody types it (§3.5).
9. **Sunday hours.** A punch on a Sunday counts in the workweek that starts that Sunday. At a shop whose weekly hours have no Sunday it's still paid, and the report flags it (`sunday_punch`).
10. **DST.** The fall-back week (Nov 1, 2026, also the first day of the Nov 1–14 period) has 169 real hours and the spring-forward week 167. A Saturday-night shift splits at local midnight by real elapsed time (PY-OT-04, PY-OT-05).

Example (tested): 25 h at shop A and 20 h at shop B in one week makes 45 h, so 5 OT hours: 2.78 to A (25/45) and 2.22 to B (20/45). Shop A's file gets 22.22 regular + 2.78 OT; shop B's gets 17.78 + 2.22.

The per-shop export columns don't change; only the hour values do. The Payroll Report shows each person's weekly breakdown (every shop, every week, OT per slice) in the drill-down.

### 3.3 Training and the C2 flag (Q11)

C2 is the "training counts toward overtime" setting. It's **on** by default: FLSA counts training as hours worked, so training on top of clocked hours adds to the weekly basis in §3.2 and carries its share of the OT. It stays a setting until Charles answers Q11.

Training is never counted twice. Where a training entry falls inside the same person's clocked worked time (at any shop), that part is already in their worked hours, so it's left out of the basis and the line gets a "training_in_hours" anomaly: it's exported as both regular and training hours, so it's paid twice unless the entry is fixed. With the setting off, every line with training gets the anomaly instead.

**Training pay (Charles, Oct 28).** Training is paid at its own flat hourly training rate and never enters commission or the greater-of: Training Pay (U) = training hours (S) × the training rate, its own line, in Labor Cost. The rate is per employee and effective-dated (`staff_training_rates`, the **Training rate** card on their Staff page). Each day's training is paid at the rate in effect that day; when that changes inside the period the line's rate is hours-weighted and shows "mixed". Without a Staff page rate, Payroll setup's training rate applies, then their hourly wage, flagged `no_training_rate`. Squire-data shops and hours typed on the report use the rate on the period's last day. A rate is history: it starts after the last locked pay period, isn't edited, and only one that hasn't started, and no locked period used, can be deleted (a database trigger enforces it).

**Overtime from training.** With C2 on, a shop's share of the week's OT can be more than the hours clocked at that shop (for example, a Saturday of training at another shop after 40 clocked hours). The OT past the clocked hours comes off that shop's training hours, so regular hours are never negative, and the line gets a `training_overtime` anomaly. Otherwise OT comes out of regular hours as always, so when training pushes a week past 40 the hourly side of the greater-of drops by those hours; taking it from training first is the alternative, pending Q11.

Still open (Q11, Charles and the CPA): whether training counts toward the 40, and whether training hours are on top of clocked hours. C2 stays a setting, on by default, since under the FLSA training is generally hours worked.

### 3.4 Regular rate for overtime (C1)

Under FLSA (29 CFR 778.117–778.120), commission is part of the regular rate, so overtime owes half-time on it, not just 1.5 × the base wage. Charles says iSolved computes blended OT, but whether its "Overtime 1.5" earning counts the Comm Sales dollars in the regular rate is an iSolved setting nobody has confirmed. The export format can't change without Charles, so:

- The platform works out what's owed for each line: 0.5 × that line's OT hours × (the person's commission top-up I, where positive, + product commission L + any guarantee top-up, across all their shops) ÷ their hours worked across all their shops. That's the equal-per-hour allocation of 778.120. The multiplier is the OT multiplier setting, so 0.5 is (1.5 − 1).
- It's always in Labor Cost (V).
- **Default (`base`):** it isn't in the file. The line gets an `ot_regular_rate` anomaly with the amount, to check against iSolved's OT or enter by hand.
- **Option (`adjust`), Needs Charles:** the file gets one more column, `E_OT Premium Adj_Dollars` (the header is a setting), only when some line has an amount. This is a format change, so it's off until Charles and iSolved agree.

### 3.5 Overtime and hours can't be lowered (C6)

Overtime comes from the punches (§3.2), and hours worked from the timesheets. An adjustment to hours worked or OT hours can't go below what the punches show: it's refused ("The punches show 41.50 of overtime, and an adjustment can't go below that. If the punches are wrong, fix them on the timesheet."). A lower value already on record (from before this rule, or an import) is floored at the punches' value and flagged `below_punches`. Adjustments need `payroll.run`, which only brand roles have (brand payroll admins: Brand Owner, Brand Admin, Bookkeeper), so shop managers can't change payroll figures at all. They fix punches on the timesheet, which is audited separately. Every adjustment is audited (`payroll.override`) with its reason.

### 3.6 Full time and part time

Full time means averaging **more than** 32 hours a week, so exactly 32.0 is part time. Brand settings, all pending Charles:

| Setting | Default | Options |
| --- | --- | --- |
| Full-time threshold (h/week) | 32 | |
| Hours basis | Clocked worked hours | worked; worked + training; worked + training + PTO |
| Averaging window | Rolling 4 weeks, ending with the period's last week | 1 to 26 weeks |

The status is shown per person in the drill-down with the average it came from. It doesn't change any pay math or the export.

## 4. Pay groups and calendars

Ray'z Inc. is one legal entity (one FEIN). In iSolved each shop is its own pay group, with a letter code, and its own pay calendar. Calendars are per pay group, not brand-wide.

| Field | Meaning |
| --- | --- |
| Label | How the pay group is named on screen and in the file name. Defaults to the shop name. |
| iSolved pay group code | iSolved's letter code for the pay group (B is Rock Island, C is Moline), 1 to 4 letters or digits, one shop per code. Shown on the Payroll Report and usable in file names. New pay groups get B and C by shop name; the rest are entered on Payroll → Setup. |
| Legal entity | The FEIN it belongs to, for §3.2. Default "Ray'z Inc." |
| Export tab | The workbook tab whose layout and formatting the file copies (§6.2). |
| Anchor start, anchor number | A known period's first Sunday and its number |
| Period length | 7 or 14 days, Sunday to Saturday. The first day must be a Sunday, so every period is whole OT workweeks (I2). |
| Check offset | Days from the period's last day to the check date (6 = the Friday after) |
| Submit-by offset | Days from the period's last day to iSolved's submission deadline (4 = the Wednesday after). 0 up to the check offset. |
| Numbers reset yearly | The first check date in a new year is period 1 |

Current calendars (verified in iSolved, read-only):

| Pay groups | Calendar |
| --- | --- |
| Rock Island, Moline, Utica, Kimberly, Silvis, Coralville, LeClaire | Bi-weekly, Sun–Sat, due in iSolved the following Wednesday, check the following Friday. Period 21 was 9/20–10/3/2026 (check 10/9); period 22 is 10/4–10/17 (due 10/21, check 10/23); period 23 is 10/18–10/31 (due 11/4, check 11/6). |
| Dubuque | Its own numbering. Period 01 was 10/4–10/17/2026 (check 10/23). Open: iSolved now gives 10/4–10/17 as period 22; until that's confirmed for Dubuque, its numbering is unchanged. |

The brand's default calendar (new pay groups start on it, and so do the brand-wide pay periods) is iSolved's: anchored on Sunday 10/4/2026 as period 22, 14 days, submit-by +4, check +6, numbers reset yearly. It's a Payroll setup setting. The OT workweek is always Sunday to Saturday (§3.2), so a bi-weekly period is exactly two workweeks.

Because the 12/13–12/26 period's check falls on 1/1/2027, that's period 1 of 2027. Calendars can be edited on Payroll → Setup; once a pay group has locked periods, its calendar can be renumbered but not moved to different dates.

**Stored period dates.** Each period's check date and submit-by date are on record in `pay_period_dates`, per pay group: the periods from about four months back to six months ahead are written from the calendar the first time payroll looks, and again when a calendar changes. On Payroll → Setup → Pay period dates, someone with `payroll.run` can move a period's dates (a holiday, or iSolved's calendar says otherwise) with a reason. The move applies to every pay group with that period and is audited (`payroll.period_dates`). The submit-by date can't be before the period's last day, the check can't be before the submit-by date, and the check is at most 31 days after the end. Dates equal to the calendar's offsets clear the reason. A locked period keeps its dates: the lock records the check date. Period numbers follow the check date actually paid, so a New Year's Day check moved into December makes that period the last of the old year.

The Payroll Report picks a period by its dates. Pay groups whose calendars share those dates are reported and locked together; Dubuque's periods are separate.

## 5. The Payroll Report

There are two screens over the same figures.

**Reports → Payroll → Payroll Report** (`/admin/reports/payroll/report`) is Charles's workbook's Locations tab. It needs the report's permission, which is brand-only like every payroll report (Brand Owner, Brand Admin and Bookkeeper have it by default; migration `core_0128` grants it), and "See pay rates and labor cost".

- **Pay period and location chips.** Shops are in the order set in Payroll setup (default Utica, Moline, Kimberly, Rock Island, Silvis, Coralville, LeClaire). Names match on letters only, so "Le Claire" is LeClaire.
- **One block per shop.** It has a title row (Utica FFFF00, Rock Island 00B0F0, Silvis 92D050) and the 19 columns A to S with the workbook's headers. The download keeps "Hourly Total " and "Training  Hours" exactly. Then a row per employee, a totals row and Gross Profit = ΣService$ − ΣTotal Wages. Money is shown in Excel's Accounting style, with negatives in parentheses and zero as "-". Service% and Prod% are `0%`. Total % of Gross is `0%` per row and `0.00%` in totals. "—" stands in for `#DIV/0!`.
- **Totals sum every row.** The workbook's ranges skip employees at five shops (§8 of Charles's spec). Rates aren't totalled; Gross /Hr and Total % of Gross come from the totals.
- **Adjusted cells** are highlighted, with the reason on hover. **"mixed"** replaces a rate that changed inside the period (§11).
- **Sales tax (reference).** This is a grey column after S: the sales tax on the employee's tickets. It's never used in any pay figure or in the file.
- **Unassigned sales.** Service or product sales with no employee on the ticket get a red line under their shop. Nobody is credited for them.
- **Review before approving:** the anomalies (§8), each with a link to that employee's drill-down.
- **Location summary:** Service Sales, Employee Cost (= Total Wages, as in the workbook) and Gross Profit per shop, plus a total.
- **Downloads.** The report comes as `.xlsx` (one "Locations" sheet laid out like the tab, with the Accounting format) or as CSV, named `Rayz Payroll Report MM.DD.YY-MM.DD.YY`. After approval, each shop's iSolved file and the all-shops workbook are offered too. Every download is audited.
- **Audit trail:** every adjustment, approval, take-back, lock and download for the period, oldest first.
- **Approval controls:** Approve figures, Take back approval and Lock period (§9).

**Payroll → Report** (`payroll.run` or `payroll.approve`) is the working screen, with the same approval controls and audit trail plus:

- **Period chips** for recent and upcoming periods, with each pay group's period number and check date.
- **When hours are due**: the period number, iSolved's submit-by date and the check date under the title, with a red notice once the submit-by date has passed and the period isn't locked (amber on the day). Each shop block shows its iSolved pay group code.
- **Reconciliation gate** (§7) at the top: either the list of mismatches or a green "every total is the sum of its rows".
- **Locations view:** per shop, Service Sales, Total Wages, O.T. Pay, Training Pay, Employee Cost (= Labor Cost), Gross Profit and Cost %, plus a total row.
- **Anomalies** (§8).
- **Per-shop blocks:** columns B to S, then O.T. Pay, Training Pay and Labor Cost highlighted as platform additions.
- **Per-employee drill-down:** the labor cost formula, O.T. Pay with "iSolved may compute blended OT higher.", Training Pay, FT/PT status, the cross-shop weekly breakdown, and the adjustment form (a value and a required reason).
- **Export preview** per shop: the exact values that will go in the file.

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

There are two layouts (Payroll setup → iSolved files):

- **0.00 on every hours and dollars column** (the default) is the reference file `expected_isolved_export.xlsx`. Every sheet uses Arial 8 with bold headers, grey fills on A1:F1 and `0.00` on columns C to H. The Key is General, or `@` when it's text, so each Key keeps its cell type. Column widths match the reference.
- **Each tab's own formatting** copies Charles's workbook cell for cell (General vs `0.00` per cell, Arial or Roboto 8 per tab, fills, alignment, borders, widths and zoom) from `src/server/payroll/isolved-template.json`. That file holds styles and header text only.

There's one row per employee from row 2. There are no totals, no blank rows and no extra columns. The sheet name is the shop's export tab.

`tests/payroll-golden.test.ts` builds the file from the golden fixture and compares it to `expected_isolved_export.xlsx` cell for cell: sheets and their order, values, cell types, number formats, fonts, fills and widths. `tests/payroll-export.test.ts` checks the workbook layout against the template.

### 6.3 Rounding

Values go out **unrounded**, exactly as the workbook has them (for example 78.2499999999999, or a NetComm of 218.667). iSolved's Timecard Import has "Implied Decimal Places" set to None by default, so it takes them as they are.

A brand setting rounds export values to 2 decimals half-up instead. It's **off**, pending Charles. Half-up works from the decimal value, not the binary float, and never uses banker's rounding: 6.315 becomes 6.32, and 2.675 becomes 2.68. On the sample data it changes 19 cells (18 NetComm and one hours value), and the total NetComm by under $0.03. The report and the gate use the same values as the file, so turning it on can't create a mismatch.

### 6.4 Upload (by hand)

1. Run the period: the figures build live from the time clock, sales and tips.
2. Review: the anomalies and drill-downs, plus adjustments with reasons.
3. Approve the figures (`payroll.approve`, brand-wide).
4. Download each shop's file (`payroll.run` or `payroll.export`), or the all-shops workbook from Reports → Payroll → iSolved export. Then upload in iSolved: Timecard Import (Excel/CSV), picking that pay group.
5. Lock the period.

File names are Payroll setup settings (Q9). A shop's file defaults to `MM.DD.YY-MM.DD.YY <shop>.xlsx`, and the all-shops workbook to `Rayz Payroll MM.DD.YY-MM.DD.YY.xlsx`. The placeholders are `{start}`, `{end}`, `{startIso}`, `{endIso}`, `{shop}`, `{payGroup}`, `{code}` (the iSolved pay group code, blank until it's set) and `{period}`. The all-shops workbook has a sheet per shop in the workbook's tab order (Rock Island, Moline, Silvis, Coralville, Utica, Kimberly, LeClaire, then the rest by name). It's marked DRAFT until the figures are approved.

Files download only while an approval covers the live figures, and once locked they come from the lock's snapshot. A change after approval holds the files until the period is approved again. Each download is audited.

## 7. Reconciliation gate

Approve-and-lock is blocked while there's any mismatch, compared to the cent (more than $0.00 or 0.00 hours). Each mismatch is listed on screen with the shop, column, the two numbers and what didn't match.

| Check | What's compared |
| --- | --- |
| Rows | Each shop's total for every summed column (hours, money, O.T. Pay, Training Pay, Labor Cost) against the sum of its lines, and each line's Labor Cost against Total Wages + O.T. Pay + Training Pay + top-up + OT premium owed |
| Training | Each shop's Training Pay against its exported `E_Training_Hours` × each line's training rate |
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
| `training_in_hours` | Training inside the person's clocked hours, so it's paid twice unless fixed; or, with C2 off, any training (§3.3) |
| `training_overtime` | Overtime past the hours clocked at a shop, taken from that shop's training hours (C2, §3.3) |
| `no_training_rate` | Training paid at the hourly rate, because the person has no training rate on their Staff page or in Payroll setup (§3.3) |
| `below_punches` | An hours or OT adjustment below what the punches show; the report pays the punches (§3.5) |
| `ot_regular_rate` | Half-time owed on commission for the period's OT, which the file doesn't carry (§3.4) |
| `late_commission` | Commission for a locked period paid in this one, with its retro OT (§2.3) |
| `refund_written_off` | Refunds bigger than the period's commission: commission is $0.00 and the rest is written off (§2.2) |
| `no_rate` | Sales but no wage and no commission rate |
| `missed_punch` | A clock-out with no clock-in, no clock-out, or a clock-in again without clocking out, in the period. That shift has no hours until a manager fixes the punch. |
| `timesheet_not_approved` | A timesheet with hours or missed punches that no manager has approved |
| `hours_not_locked` | The shop's timesheets aren't locked for the period. Only listed when **Hours come from the time clock** is off; when it's on, this blocks the lock (§9). |
| `sales_day_without_hours` | Service sales on a day with no hours at that shop, for someone who has hours in the period (a missed clock-in?) |
| `hours_not_from_clock` | Worked hours typed in or imported rather than clocked (while hours come from the clock) |
| `unassigned_sales` | Service or product sales at the shop with no employee on the ticket (Squire's "Unassigned sales"). Nobody is credited for them. |
| `mixed_rates` | A wage, service % or product % changed inside the period, so the report shows "mixed" (§11) |
| `hours_source` | PTO or training time entries left unpaid because those hours are entered by a manager (§11) |
| `cross_source_ot` | Someone with hours at a shop on the platform and a shop on Squire data, for the same legal entity. Weekly OT spans both and Squire's report has only the period's total, so the O.T. hours are typed (§1.2) |
| `rollout_source` | A shop that books here with its period on Squire data, or one still booking on Squire with its period from here (§1.2) |

The time clock's flags cover shops not yet locked; a locked shop is history.

The two workbook cases waiting on Q17 (the Coralville NetComm typed above its formula, and the Moline owner row with hours at $0 cost and service sales in the feed) are flagged and left exactly as entered. Nothing is guessed.

## 9. Approve and lock

The flow is run → review → approve → lock. Each step is recorded.

- **Approve** (`payroll.approve`, brand-wide) takes the period's figures as they stand: every shop's rows (inputs, rates, adjustments and results), totals and iSolved file, hashed (`payroll_approvals.figures_hash`), with Service Sales, Employee Cost and Gross Profit per shop. It's refused while the reconciliation gate has a mismatch, or while hours come from the clock and a shop's timesheets aren't locked. An optional note is kept.
- **Changed since approval.** Any change that would alter what's paid or uploaded hashes differently: an adjustment, a late punch, a sale, a rate. The approval then no longer covers the figures. The screens say so, the iSolved files are held, and the lock is refused until someone approves again. Approving changed figures takes back the earlier approval ("Approved again with changed figures").
- **Take back an approval** before the lock, with a required reason. Approvals are never edited or deleted; a database trigger refuses both. A take-back is a one-time change to the row.
- **Lock** needs a current approval. It rechecks the hash inside the transaction and locks every pay group whose calendar has that period. It stores a snapshot per pay group: the shop block, lines, totals and export rows, plus the OT each slice was given (`payroll_locked_ot`). After locking, time entries and adjustments in the period are refused, and the report shows the snapshot. A locked period's approval can't be taken back.
- **Audit:** `payroll.approve`, `payroll.approval_revoked`, `payroll.lock` (with the approval's id), `payroll.download`, `payroll.isolved_file` and `payroll.report_file`, plus the adjustments (`payroll.override`). Every one carries the period's dates, and the audit trail on both screens lists them.
- **Hours come from the time clock** (a payroll setting, on by default; Charles decided the basic clock ships at launch). Approval and the lock wait until every shop's timesheets are locked for each day of the period. A shop's timesheets lock (Payroll → Timesheets) only after the period ends and every timesheet with hours or missed punches is approved by a manager.
- "Approve and lock" in one step remains for the API and older callers. It records both steps.

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
| Training counts toward OT (C2) | On (only training on top of clocked hours) | Pending Q11 (Charles and the CPA) |
| Commission base: card surcharge | Left out (the shop's) | |
| Commission base: loyalty rewards | Come off the sale | Pending Charles (Q15) |
| OT regular rate (C1) | `base`: the premium owed is flagged, not in the file | Needs Charles: `adjust` adds the premium column |
| OT premium column header | `E_OT Premium Adj_Dollars` | Used only with `adjust` |
| Round export to 2 decimals, half-up | Off (unrounded, as today) | Pending Charles (Q4) |
| iSolved file cell formats | 0.00 on every hours and dollars column (the reference file) | |
| A shop's file name; the all-shops workbook's name | `{start}-{end} {shop}`; `Rayz Payroll {start}-{end}` | Pending Charles (Q9) |
| Earning code per column | The workbook's headers | |
| Card tips paid outside payroll go under | `E_Cash Tips Recd_Dollars` (with cash tips, as today). Another code gives them their own column | Pending Charles and his CPA (Q2) |
| PTO hours and training hours come from | Time entries, or a manager's entry with a reason. Can also be time entries only (typing them on the report is refused) or a manager only (clocked PTO or training is left out and flagged) | Pending Charles (Q10) |
| Payroll Report shop order; all-shops workbook sheet order | The workbook's | |
| Full-time threshold, hours basis, window | 32 h; clocked worked hours; rolling 4 weeks | Pending Charles |

Per pay group: label, legal entity, iSolved pay group code, export tab and calendar, including the submit-by offset (§4). Per period: its check and submit-by dates (§4). Per person (Payroll setup, and the Staff page's Payroll (iSolved) card): iSolved employee number (the Key), Key as text, iSolved name (`LAST, FIRST`), export position, "$0 hourly pay" (the owner's row: hours go to iSolved, Hourly Total is $0), and rates per shop.

**Effective-dated rates.** With compensation plans on and Payroll using them (Staff → Compensation, both off by default), each employee's wage, service % and product % come from their plan's versions. Each sale is paid at the rate in effect on its checkout date (a refund at the original sale's date), and each day's hours at that day's wage. Where a rate changed inside the period, the report shows "mixed" and flags it (`mixed_rates`). With plans off, the rates are Payroll setup's, one per employee per shop. The training rate is effective-dated either way, on the Staff page, with Payroll setup's as the fallback (§3.3).

## 12. Golden files

Charles's golden data (33 employee rows, the seven iSolved tabs) holds real names, Keys and pay rates, so it never goes in the repo.

- `tests/fixtures/payroll-golden/anon/` is committed. It's `scripts/payroll-golden-anonymize.py`'s output: fictional names, Keys, rates, hours and sales that keep every formula branch, typed cell, zero and `#DIV/0!` of the original, plus the matching `expected_isolved_export.xlsx`.
- `tests/fixtures/payroll-golden/private/` is gitignored. It's where the real `golden.json` and `expected_isolved_export.xlsx` go on a machine that has them.

`tests/payroll-golden.test.ts` runs against both (the private one only when present):

- every row's Hourly Total, Gross /Hr, Commission$, Service Total, Product Total, NetComm, Total Wages and Total % of Gross;
- every typed workbook cell as an adjustment with a reason;
- the workbook's cached totals as known bugs, and the corrected all-rows totals. Each total's formula is checked first (`totalsFormulaProblems`): a range that includes its own cell (circular), runs outside the shop's block or skips rows is flagged, and a circular total's cached value is never compared, because Excel's value for it is stale (I12);
- the summary;
- the Payroll Report download's headers, values and formats;
- the iSolved export, cell for cell against `expected_isolved_export.xlsx`.

## 13. Declined and open

| Item | Status |
| --- | --- |
| C1 regular-rate OT | **Needs Charles.** The premium owed on commission is computed, in Labor Cost and flagged for hand entry (§3.4). The file column is a switch, off. |
| C3 card tips off Cash Tips Recd | **Needs Charles and his CPA.** `cardTipsHeader` gives card tips their own column; it's set to Cash Tips Recd, so the file is unchanged (§11). |
| Training pay | Resolved (Charles, Oct 28): training hours × the employee's own effective-dated training rate, its own line outside the greater-of, in Labor Cost (§3.3). |
| Q11 training toward OT, and on top of clocked hours | Open for Charles and the CPA. C2 on by default; training inside a clocked shift isn't counted twice and is flagged (§3.3). |
| Q15 loyalty in the commission base | Open. Rewards come off the sale, as today; a setting (§2.2). |
| Q16 Dubuque export | Resolved: Dubuque has its own pay calendar and its own file in the same format. |
| Q17 owner row and the Coralville NetComm gap | Open. Flagged, not fixed. |
| FT/PT basis and window, 2-decimal rounding, file names, PTO and training source, card tips code | Pending Charles; configurable, defaults above (§11). |
