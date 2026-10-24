# Payroll workbook discrepancies

What's wrong in the current payroll workbook (the Locations sheet and the per-shop iSolved tabs), what the platform shows instead, and why. Every number here comes from rerunning the workbook's own rows through the platform's engine (`scripts/payroll-golden.ts --totals`). The rows themselves are right: all 33 employee rows match Excel's cached results on 293 computed cells, with 0 mismatches, and an independent check by Testing Bot found the same. What's wrong is the **totals**, plus a few typed cells and lookups.

The platform doesn't carry any of these over. Every subtotal and grand total on the Payroll Report and in every export file is a sum of line items, and approve-and-lock is blocked if any total is even $0.01 away from the sum of its rows (see [the spec](payroll-report-spec.md#7-reconciliation-gate)).

**Anonymized:** no names, Employee Numbers or iSolved Keys. Shop totals are shown; people are referred to by shop and a letter ("Coralville barber A") or as "the owner row". A copy with real values went to Charles separately and is not in the repo.

Column letters are the Locations sheet's: B regular hours, C wage, D hourly total, E service $, F gross/hour, G service %, H service commission, I service total, J product $, K product %, L product total, M NetComm (the Comm Sales export column), N Total Wages, O % of gross, P PTO, Q OT hours, R tips, S training hours.

## 1. Shop totals that skip rows

The total row's `SUM` range stops before the last employee rows, so those people are left out of the shop's totals and the Locations summary.

| Shop | Cell | Formula | Shown | Sum of rows | Cause |
| --- | --- | --- | --- | --- | --- |
| Rock Island | B39 hours | `SUM(B34:B36)` | 231.65 | 283.52 | Range omits row 37 (and row 38, whose hours are blank) |
| Rock Island | D39 hourly total | `SUM(D34:D36)` | 3,630.015 | 4,434.00 | Same |
| Rock Island | E39 service $ | `SUM(E34:E36)` | 6,988.67 | 7,914.33 | Same |
| Rock Island | H39 commission | `SUM(H34:H36)` | 2,795.468 | 3,165.732 | Same |
| Rock Island | I39 service total | `SUM(I34:I36)` | −834.547 | −1,268.268 | Same |
| Rock Island | L39, M39 | `SUM(…34:…36)` | 15.141 | 16.0395 | Same |
| Rock Island | N39 Total Wages | `SUM(N34:N36)` | 3,645.156 | 4,450.0395 | Same |
| Rock Island | R39 tips | `SUM(R34:R36)` | 1,974.51 | 2,209.51 | Same |
| Silvis | B47 hours | `SUM(B43:B44)` | 155.17 | 276.24 | Range omits rows 45–46 |
| Silvis | D47 hourly total | `SUM(D43:D44)` | 2,405.135 | 4,257.285 | Same |
| Silvis | E47 service $ | `SUM(E43:E44)` | 3,681.02 | 6,753.77 | Same |
| Silvis | H47 commission | `SUM(H43:H44)` | 1,472.408 | 2,701.508 | Same |
| Silvis | I47 service total | `SUM(I43:I44)` | −932.727 | −1,555.777 | Same |
| Silvis | N47 Total Wages | `SUM(N43:N44)` | 2,414.1305 | 4,266.2805 | Same |
| Silvis | R47 tips | `SUM(R43:R44)` | 847.00 | 1,562.22 | Same |
| Coralville | B55 hours | `SUM(B51:B52)` | 97.95 | 219.03 | Range omits rows 53–54 |
| Coralville | D55 hourly total | `SUM(D51:D52)` | 1,665.15 | 3,956.79 | Same |
| Coralville | E55 service $ | `SUM(E51:E52)` | 3,618.17 | 7,722.05 | Same |
| Coralville | H55 commission | `E55*G55` | 1,675.65 | 3,088.82 | A rate times the short total, instead of a sum of the rows |
| Coralville | I55 service total | `SUM(I51:I52)` | −217.882 | −867.97 | Range omits rows 53–54 |
| Coralville | L55 product total | `SUM(L51:L52)` | 10.50 | 18.915 | Same |
| Coralville | M55 NetComm | `SUM(M51:M52)` | 133.96 | 142.375 | Same |
| Coralville | N55 Total Wages | `SUM(N51:N52)` | 1,675.65 | 3,975.705 | Same |
| Coralville | R55 tips | `SUM(R51:R52)` | 996.45 | 2,011.85 | Same |
| LeClaire | H63 commission | `SUM(H59:H61)` | 1,442.44 | 2,196.424 | Range starts at the title and header rows and omits row 62 |
| LeClaire | I63 service total | `SUM(I59:I61)` | 289.085 | −30.151 | Same |
| LeClaire | N63 Total Wages | `SUM(N59:N61)` | 1,445.7385 | 2,518.9585 | Same |
| LeClaire | R63 tips | `SUM(R59:R61)` | 931.80 | 1,438.30 | Same |
| LeClaire | G63 % of gross | `N63/E63` | 26.33% | 45.87% | Divides the short N63 |
| Utica | E9 service $ | `SUM(E3:E6)` | 9,945.53 | 12,185.84 | Range omits rows 7–8 |
| Utica | H9 commission | `SUM(H3:H6)` | 3,978.212 | 4,874.336 | Same |

## 2. Totals that include themselves or spill into other shops

These ranges run past the shop's block, so they include their own cell (a circular reference) and other shops' rows. The shown value is stale or arbitrary.

| Shop | Cell | Formula | Shown | Sum of rows | Cause |
| --- | --- | --- | --- | --- | --- |
| Utica | L9 product total | `SUM(L3:L60)` | 39.1065 | 14.244 | Spills down to row 60 and includes itself |
| Utica | R9 tips | `SUM(R3:R60)` | 4,790.50 | 3,572.10 | Same |
| Kimberly | B30 hours | `SUM(B24:B37)` | 296.49 | 294.03 | Includes itself (row 30) and Rock Island's rows |
| Kimberly | R30 tips | `SUM(R24:R37)` | 2,000.00 | 2,467.70 | Same |

## 3. Totals that are missing

The total row leaves the cell blank, so the column has no shop total at all.

| Shop | Column | Sum of rows |
| --- | --- | --- |
| Utica | S training hours | 3.5 |
| Kimberly | J product $ | 132.54 |
| Kimberly | Q OT hours | 0.10 |
| Kimberly | S training hours | 3.5 |
| Rock Island | J product $ | 106.93 |
| Rock Island | Q OT hours | 0.39 |
| Rock Island | S training hours | 16 |
| Silvis | J product $ | 59.97 |
| Silvis | Q OT hours | 0.33 |
| Silvis | S training hours | 14 |
| Coralville | J product $ | 126.10 |
| LeClaire | J product $ | 21.99 |
| LeClaire | S training hours | 7 |

## 4. Totals of rates and percentages

These add up wages, percentages or per-hour values, so the shown number means nothing. The platform shows rate columns blank on total rows, and computes per-hour and % of gross from the totals (total service ÷ total hours, total wages ÷ total service).

| Shop | Cell | Formula | Shown |
| --- | --- | --- | --- |
| Utica | C9 wage | `SUM(C3:C60)` | 131 |
| Moline | C20 wage | `SUM(C13:C19)` | 128 |
| Kimberly | C30 wage | `SUM(C24:C37)` | 90 |
| Rock Island | C39 wage | `SUM(C34:C36)` | 47 |
| Silvis | C47 wage | `SUM(C43:C46)` | 61.5 |
| Silvis | K47 product % | `SUM(K43:K44)` | 0.30 |
| Coralville | C55 wage | `SUM(C51:C52)` | 34 |
| Coralville | K55 product % | `SUM(K51:K52)` | 0.30 |
| Coralville | F55 gross/hour | `SUM(F51:F52)` | 70.769 |
| LeClaire | C63 wage | `SUM(C61:C62)` | 31 |
| LeClaire | K63 product % | `SUM(K59:K61)` | 0.15 |
| LeClaire | F63 gross/hour | sums per-hour values | 75.686 |

## 5. Locations summary

The summary takes each shop's total row, so every short total above flows into it. Total Wages is what the workbook calls Employee Cost.

| Location | Service shown | Service (rows) | Employee Cost shown | Total Wages (rows) | Gross Profit shown | Gross Profit (rows) |
| --- | --- | --- | --- | --- | --- | --- |
| Utica | 9,945.53 | 12,185.84 | 6,978.31 | 6,978.31 | 2,967.23 | 5,207.53 |
| Moline | 16,586.34 | 16,586.34 | 7,081.63 | 7,081.63 | 9,504.72 | 9,504.72 |
| Kimberly | 8,240.83 | 8,240.83 | 4,577.35 | 4,577.35 | 3,663.48 | 3,663.48 |
| Rock Island | 6,988.67 | 7,914.33 | 3,645.16 | 4,450.04 | 3,343.51 | 3,464.29 |
| Silvis | 3,681.02 | 6,753.77 | 2,414.13 | 4,266.28 | 1,266.89 | 2,487.49 |
| LeClaire | 5,491.06 | 5,491.06 | 1,445.74 | 2,518.96 | 4,045.32 | 2,972.10 |
| Coralville | 3,618.17 | 7,722.05 | 1,675.65 | 3,975.71 | 1,942.52 | 3,746.35 |
| **Total** | **54,551.62** | **64,894.22** | **27,817.95** | **33,848.26** | **26,733.67** | **31,045.96** |

The column-by-column numbers above are what the workbook's own formulas give once each total sums its own rows. The platform goes one step further and counts OT pay and training pay as cost (section 6).

## 6. OT pay and training pay left out of cost

Total Wages (N) is `max(hourly total, service commission) + product commission`, where the hourly total uses **regular hours only** (B = worked − OT). So the workbook leaves **all** OT pay (not just the premium) and **all** training pay out of Total Wages, Employee Cost and Gross Profit. iSolved still pays both, from the OT and Training hours in the export.

The platform adds three columns to the right of the workbook's (the export doesn't change):

- **T O.T. Pay** = 1.5 × base wage × OT hours, after the cross-shop split. iSolved computes blended OT itself, which may come out higher.
- **U Training Pay** = training rate (or the hourly wage when there's no training rate) × training hours. This is a setting, **on** by default.
- **V Labor Cost** = N + T + U. This is the Payroll Report's Employee Cost.

| Location | Total Wages (rows) | OT hours | O.T. Pay | Training hours | Training Pay | Labor Cost | Gross Profit after labor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Utica | 6,978.31 | 0 | 0.00 | 3.5 | 54.25 | 7,032.56 | 5,153.28 |
| Moline | 7,081.63 | 0 | 0.00 | 0 | 0.00 | 7,081.63 | 9,504.72 |
| Kimberly | 4,577.35 | 0.10 | 2.33 | 3.5 | 54.25 | 4,633.92 | 3,606.91 |
| Rock Island | 4,450.04 | 0.39 | 9.07 | 16 | 250.00 | 4,709.11 | 3,205.22 |
| Silvis | 4,266.28 | 0.33 | 7.67 | 14 | 215.25 | 4,489.20 | 2,264.57 |
| Coralville | 3,975.71 | 0 | 0.00 | 0 | 0.00 | 3,975.71 | 3,746.35 |
| LeClaire | 2,518.96 | 0 | 0.00 | 7 | 108.50 | 2,627.46 | 2,863.60 |
| **Total** | **33,848.26** | **0.82** | **19.07** | **44** | **682.25** | **34,549.57** | **30,344.65** |

Training is paid at the hourly wage here because the workbook has no training rate. On the platform, a training rate can be set per person.

## 7. Typed cells (flagged, not fixed)

These are typed over a formula, or typed where the feed has nothing. The platform carries a hand-entered value only as an **override with a reason**, shown in the anomaly list on every run. The two Q17 items are left exactly as the workbook has them until Charles decides.

| Where | What | Platform |
| --- | --- | --- |
| Coralville barber A, M51 | NetComm typed **130.66**; the formula gives **7.20**. The report's Total Wages uses 7.20 and the export's Comm Sales sends 130.66, a **$123.46** gap. | Override kept as typed, flagged "netcomm_gap". **Q17, pending Charles.** |
| Moline owner row, row 19 | 80 hours typed, D19 (hourly total) typed **0** although the wage is filled in, E19 (service) typed **0** although the feed has **$20.00** of service sales, and **$64.95** of product in the feed with no product % (K) and no J. | Flagged "owner_case" (hours at $0 labor cost) and "sales_without_hours". Nothing guessed. **Q17, pending Charles.** |
| Utica barber A, row 8 | Hours (64) and service (0) typed; the person isn't in the feed. At exactly 32.0 hours a week this person is **part time** under the ">32" rule. | Comes from time entries and POS sales instead; would be an override if typed. |
| Rock Island barber A, row 36 | Hours, service and tips typed over the feed (+5.53 h, +$342.22 service, +$130.54 tips). | Override with a reason if still needed. |
| Rock Island barber B, row 38 | Service and tips typed; hours blank. | Same. |
| LeClaire barber A, row 61 | Service and tips typed over the feed (+$1,487.57 service, +$319.50 tips). | Same. |
| Silvis tab F5, Moline tab H3 | Typed into the iSolved tab instead of linking to Locations. | The export is written from the report's rows; nothing is typed into it. |

## 8. Lookups and layout

| Where | Problem | Platform |
| --- | --- | --- |
| Rock Island E35, E37 | `LOOKUP` with mismatched vector sizes (`A2:A34` against `J2:J35`). | People are joined on their staff ID, never on a name lookup. |
| Rock Island and Moline, service and tips columns | The lookup range for hours (`A2:A36`) differs from the range for service and tips (`A2:A34`). | Same. |
| Moline B13–B19 | The hours lookup searches `A2:A37`, which takes in three rows of the product block, so the search vector isn't sorted. Whether Moline barber A's hours resolve correctly (21.83) depends on how Excel's binary search treats blank cells. One plausible reading returns another person's 43.32 instead, which would cut that barber's NetComm from 207.94 to 11.00. | Same. |
| Kimberly B, Silvis B and E | Lookup ranges end at row 39, so anyone whose name sorts after the last row in range gets the wrong person's numbers. | Same. |
| Kimberly header row 23 | No "Product$" header in J23, unlike every other block. | One layout for every shop. |
| LeClaire tab G2, G3 | Link to `Locations!P63` and `P64` (the total row and below), two rows too low; they should be P61 and P62. The value is 0 today, so nothing has gone wrong yet. | Each export row is written from the same line as the report row. |
| Locations, all shops | No Product$ total for Utica, Kimberly or Rock Island (section 3). | Every column has a total. |
| iSolved tabs | Key, number format, fill and font vary by tab (a text Key with `@`, General vs `0.00`, Roboto vs Arial, different widths). | Kept as they are: the exporter copies each tab's formatting cell for cell, and a test diffs it. |

## 9. Not in the workbook at all

- **Full time / part time.** Nothing in the workbook marks it. The platform derives it: full time is averaging **more than** 32 hours a week, so exactly 32.0 is part time. The hours basis and the averaging window are settings (default: clocked worked hours over a rolling 4 weeks), pending Charles.
- **Cross-shop overtime.** The workbook types OT hours by hand per shop. The platform works OT out per Sun–Sat workweek across every shop of the same legal entity and splits it by each shop's share of the hours (spec §3.2).
- **Training possibly counted twice (Q11).** The workbook exports training hours as their own earning next to the regular hours. If the clocked hours already include the training time, it's paid twice. The platform flags every training line ("training_in_hours") until Charles answers Q11. The C2 flag (training counts toward the weekly 40) stays off until then.
