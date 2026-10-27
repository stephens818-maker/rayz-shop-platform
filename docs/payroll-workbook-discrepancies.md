# Payroll workbook discrepancies

What's wrong in the current payroll workbook (the Locations sheet and the per-shop iSolved tabs), what the platform shows instead, and why. The rows themselves are right: all 33 employee rows match Excel's cached results on 293 computed cells, with 0 mismatches, and an independent check by Testing Bot found the same. What's wrong is the **totals**, plus a few typed cells and lookups.

The platform doesn't carry any of these over. Every subtotal and grand total on the Payroll Report and in every export file is a sum of line items, and approve-and-lock is blocked if any total is even $0.01 away from the sum of its rows (see [the spec](payroll-report-spec.md#7-reconciliation-gate)).

**Anonymized:** every amount, hour and rate here comes from the anonymized copy of the workbook (`tests/fixtures/payroll-golden/anon/golden.json`): fictional names, keys, rates, hours, sales and tips on the same shops, rows, typed cells, zeros and formula ranges. Each problem shows up exactly as it does in the real workbook, but none of the figures are real. People are referred to by shop and a letter ("Coralville barber A") or as "the owner row". To see the real figures, run `scripts/payroll-golden.ts --totals` on the workbook locally; don't paste its output into the repo, a ticket or a chat.

Column letters are the Locations sheet's: B regular hours, C wage, D hourly total, E service $, F gross/hour, G service %, H service commission, I service total, J product $, K product %, L product total, M NetComm (the Comm Sales export column), N Total Wages, O % of gross, P PTO, Q OT hours, R tips, S training hours.

## 1. Shop totals that skip rows

The total row's `SUM` range stops before the last employee rows, so those people are left out of the shop's totals and the Locations summary.

| Shop | Cell | Formula | Shown | Sum of rows | Cause |
| --- | --- | --- | --- | --- | --- |
| Rock Island | B39 hours | `SUM(B34:B36)` | 175.89 | 215.15 | Range omits row 37 (and row 38, whose hours are blank) |
| Rock Island | D39 hourly total | `SUM(D34:D36)` | 2,720.8225 | 3,319.5375 | Same |
| Rock Island | E39 service $ | `SUM(E34:E36)` | 4,623.20 | 5,618.07 | Same |
| Rock Island | H39 commission | `SUM(H34:H36)` | 1,733.6823 | 2,171.4251 | Same |
| Rock Island | I39 service total | `SUM(I34:I36)` | −987.1402 | −1,148.1124 | Same |
| Rock Island | L39, M39 | `SUM(…34:…36)` | 24.4116 | 28.5732 | Same |
| Rock Island | N39 Total Wages | `SUM(N34:N36)` | 2,745.2341 | 3,348.1107 | Same |
| Rock Island | R39 tips | `SUM(R34:R36)` | 2,279.92 | 3,145.97 | Same |
| Silvis | B47 hours | `SUM(B43:B44)` | 102.25 | 182.14 | Range omits rows 45–46 |
| Silvis | D47 hourly total | `SUM(D43:D44)` | 2,029.375 | 3,588.6775 | Same |
| Silvis | E47 service $ | `SUM(E43:E44)` | 3,655.33 | 6,902.42 | Same |
| Silvis | H47 commission | `SUM(H43:H44)` | 1,615.7706 | 2,992.7758 | Same |
| Silvis | I47 service total | `SUM(I43:I44)` | −413.6044 | −595.9017 | Same |
| Silvis | N47 Total Wages | `SUM(N43:N44)` | 2,047.497 | 3,606.7995 | Same |
| Silvis | R47 tips | `SUM(R43:R44)` | 743.10 | 1,719.93 | Same |
| Coralville | B55 hours | `SUM(B51:B52)` | 126.31 | 234.09 | Range omits rows 53–54 |
| Coralville | D55 hourly total | `SUM(D51:D52)` | 3,557.035 | 5,386.28 | Same |
| Coralville | E55 service $ | `SUM(E51:E52)` | 5,775.24 | 8,827.65 | Same |
| Coralville | H55 commission | `E55*G55` | 3,570.7656 | 3,749.5798 | A rate times the short total, instead of a sum of the rows |
| Coralville | I55 service total | `SUM(I51:I52)` | −934.9206 | −1,636.7002 | Range omits rows 53–54 |
| Coralville | L55 product total | `SUM(L51:L52)` | 13.7306 | 20.2854 | Same |
| Coralville | M55 NetComm | `SUM(M51:M52)` | 150.5344 | 157.0892 | Same |
| Coralville | N55 Total Wages | `SUM(N51:N52)` | 3,570.7656 | 5,406.5654 | Same |
| Coralville | R55 tips | `SUM(R51:R52)` | 594.16 | 1,288.77 | Same |
| LeClaire | H63 commission | `SUM(H59:H61)` | 599.1475 | 1,345.0443 | Range starts at the title and header rows and omits row 62 |
| LeClaire | I63 service total | `SUM(I59:I61)` | 188.6275 | −380.4957 | Same |
| LeClaire | N63 Total Wages | `SUM(N59:N61)` | 606.6267 | 1,921.6467 | Same |
| LeClaire | R63 tips | `SUM(R59:R61)` | 364.83 | 1,327.15 | Same |
| LeClaire | G63 % of gross | `N63/E63` | 17.80% | 56.40% | Divides the short N63 |
| Utica | E9 service $ | `SUM(E3:E6)` | 9,780.05 | 10,327.21 | Range omits rows 7–8 |
| Utica | H9 commission | `SUM(H3:H6)` | 3,704.7604 | 3,989.2836 | Same |

## 2. Totals that include themselves or spill into other shops

These ranges run past the shop's block, so they include their own cell (a circular reference) and other shops' rows. Excel's cached value for a circular cell is stale, so "Shown" here is what the range's employee rows add up to, not counting the cell itself. The platform's golden check marks these cells circular and never compares them (`totalsFormulaProblems`).

| Shop | Cell | Formula | Shown | Sum of rows | Cause |
| --- | --- | --- | --- | --- | --- |
| Utica | L9 product total | `SUM(L3:L60)` | 172.8288 | 6.3128 | Spills down to row 60 and includes itself |
| Utica | R9 tips | `SUM(R3:R60)` | 12,783.69 | 1,881.45 | Same |
| Kimberly | B30 hours | `SUM(B24:B37)` | 551.73 | 336.58 | Includes itself (row 30) and Rock Island's rows |
| Kimberly | R30 tips | `SUM(R24:R37)` | 5,011.38 | 1,865.41 | Same |

## 3. Totals that are missing

The total row leaves the cell blank, so the column has no shop total at all.

| Shop | Column | Sum of rows |
| --- | --- | --- |
| Utica | S training hours | 2 |
| Kimberly | J product $ | 128.44 |
| Kimberly | Q OT hours | 1.93 |
| Kimberly | S training hours | 3 |
| Rock Island | J product $ | 172.89 |
| Rock Island | Q OT hours | 0.43 |
| Rock Island | S training hours | 15 |
| Silvis | J product $ | 90.61 |
| Silvis | Q OT hours | 0.48 |
| Silvis | S training hours | 12.5 |
| Coralville | J product $ | 116.10 |
| LeClaire | J product $ | 93.49 |
| LeClaire | S training hours | 7 |

## 4. Totals of rates and percentages

These add up wages, percentages or per-hour values, so the shown number means nothing. The platform shows rate columns blank on total rows, and computes per-hour and % of gross from the totals (total service ÷ total hours, total wages ÷ total service).

| Shop | Cell | Formula | Shown |
| --- | --- | --- | --- |
| Utica | C9 wage | `SUM(C3:C60)` | 623.50 |
| Moline | C20 wage | `SUM(C13:C19)` | 136.75 |
| Kimberly | C30 wage | `SUM(C24:C37)` | 173.25 |
| Rock Island | C39 wage | `SUM(C34:C36)` | 46.25 |
| Silvis | C47 wage | `SUM(C43:C46)` | 78.75 |
| Silvis | K47 product % | `SUM(K43:K44)` | 0.28 |
| Coralville | C55 wage | `SUM(C51:C52)` | 54.50 |
| Coralville | K55 product % | `SUM(K51:K52)` | 0.26 |
| Coralville | F55 gross/hour | `SUM(F51:F52)` | 81.8503 |
| LeClaire | C63 wage | `SUM(C61:C62)` | 37.50 |
| LeClaire | K63 product % | `SUM(K59:K61)` | 0.08 |
| LeClaire | F63 gross/hour | sums per-hour values | 95.8758 |

## 5. Locations summary

The summary takes each shop's total row, so every short total above flows into it. Total Wages is what the workbook calls Employee Cost.

| Location | Service shown | Service (rows) | Employee Cost shown | Total Wages (rows) | Gross Profit shown | Gross Profit (rows) |
| --- | --- | --- | --- | --- | --- | --- |
| Utica | 9,780.05 | 10,327.21 | 5,524.59 | 5,524.59 | 4,255.46 | 4,802.62 |
| Moline | 16,895.30 | 16,895.30 | 6,852.70 | 6,852.70 | 10,042.60 | 10,042.60 |
| Kimberly | 13,212.48 | 13,212.48 | 7,699.37 | 7,699.37 | 5,513.11 | 5,513.11 |
| Rock Island | 4,623.20 | 5,618.07 | 2,745.23 | 3,348.11 | 1,877.97 | 2,269.96 |
| Silvis | 3,655.33 | 6,902.42 | 2,047.50 | 3,606.80 | 1,607.83 | 3,295.62 |
| LeClaire | 3,407.07 | 3,407.07 | 606.63 | 1,921.65 | 2,800.44 | 1,485.42 |
| Coralville | 5,775.24 | 8,827.65 | 3,570.77 | 5,406.57 | 2,204.47 | 3,421.08 |
| **Total** | **57,348.67** | **65,190.20** | **29,046.78** | **34,359.79** | **28,301.89** | **30,830.41** |

The column-by-column numbers above are what the workbook's own formulas give once each total sums its own rows. The platform goes one step further and counts OT pay and training pay as cost (section 6).

## 6. OT pay and training pay left out of cost

Total Wages (N) is `max(hourly total, service commission) + product commission`, where the hourly total uses **regular hours only** (B = worked − OT). So the workbook leaves **all** OT pay (not just the premium) and **all** training pay out of Total Wages, Employee Cost and Gross Profit. iSolved still pays both, from the OT and Training hours in the export.

The platform adds three columns to the right of the workbook's (the export doesn't change):

- **T O.T. Pay** = 1.5 × base wage × OT hours, after the cross-shop split. iSolved computes blended OT itself, which may come out higher.
- **U Training Pay** = training rate (or the hourly wage when there's no training rate) × training hours. This is a setting, **on** by default.
- **V Labor Cost** = N + T + U, plus the regular-rate OT premium owed on commission (spec §3.4). This is the Payroll Report's Employee Cost. The table leaves the premium out: the three people with OT earn under their hourly pay in service commission, so only their product commission raises the regular rate, by about $0.19 of premium in all.

| Location | Total Wages (rows) | OT hours | O.T. Pay | Training hours | Training Pay | Labor Cost | Gross Profit after labor |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Utica | 5,524.59 | 0 | 0.00 | 2 | 31.50 | 5,556.09 | 4,771.12 |
| Moline | 6,852.70 | 0 | 0.00 | 0 | 0.00 | 6,852.70 | 10,042.60 |
| Kimberly | 7,699.37 | 1.93 | 47.77 | 3 | 49.50 | 7,796.64 | 5,415.84 |
| Rock Island | 3,348.11 | 0.43 | 10.16 | 15 | 231.25 | 3,589.52 | 2,028.55 |
| Silvis | 3,606.80 | 0.48 | 13.32 | 12.5 | 238.88 | 3,859.00 | 3,043.42 |
| Coralville | 5,406.57 | 0 | 0.00 | 0 | 0.00 | 5,406.57 | 3,421.08 |
| LeClaire | 1,921.65 | 0 | 0.00 | 7 | 138.00 | 2,059.65 | 1,347.42 |
| **Total** | **34,359.79** | **2.84** | **71.25** | **39.5** | **689.13** | **35,120.17** | **30,070.03** |

Training is paid at the hourly wage here because the workbook has no training rate. On the platform, a training rate can be set per person.

## 7. Typed cells (flagged, not fixed)

These are typed over a formula, or typed where the feed has nothing. The platform carries a hand-entered value only as an **override with a reason**, shown in the anomaly list on every run. The two Q17 items are left exactly as the workbook has them until Charles decides.

| Where | What | Platform |
| --- | --- | --- |
| Coralville barber A, M51 | NetComm typed **149.96**; the formula gives **13.16**. The report's Total Wages uses 13.16 and the export's Comm Sales sends 149.96, a **$136.80** gap. | Override kept as typed, flagged "netcomm_gap". **Q17, pending Charles.** |
| Moline owner row, row 19 | Hours typed, D19 (hourly total) typed **0** although the wage is filled in, E19 (service) typed **0** although the feed has service sales, and **$93.49** of product with no product % (K). | Flagged "owner_case" (hours at $0 labor cost) and "sales_without_hours". Nothing guessed. **Q17, pending Charles.** |
| Utica barber A, row 8 | Hours and service (0) typed; the person isn't in the feed. Whether this person is full or part time depends on the ">32 hours a week" rule, so typed hours decide it. | Comes from time entries and POS sales instead; would be an override if typed. |
| Rock Island barber A, row 36 | Hours, service and tips typed over the feed. | Override with a reason if still needed. |
| Rock Island barber B, row 38 | Service and tips typed; hours blank. | Same. |
| LeClaire barber A, row 61 | Service and tips typed over the feed. | Same. |
| Silvis tab F5, Moline tab H3 | Typed into the iSolved tab instead of linking to Locations. | The export is written from the report's rows; nothing is typed into it. |

## 8. Lookups and layout

| Where | Problem | Platform |
| --- | --- | --- |
| Rock Island E35, E37 | `LOOKUP` with mismatched vector sizes (`A2:A34` against `J2:J35`). | People are joined on their staff ID, never on a name lookup. |
| Rock Island and Moline, service and tips columns | The lookup range for hours (`A2:A36`) differs from the range for service and tips (`A2:A34`). | Same. |
| Moline B13–B19 | The hours lookup searches `A2:A37`, which takes in three rows of the product block, so the search vector isn't sorted. Whether Moline barber A's hours resolve correctly depends on how Excel's binary search treats blank cells. One plausible reading returns another person's hours instead, which would cut that barber's NetComm to a fraction of what it should be. | Same. |
| Kimberly B, Silvis B and E | Lookup ranges end at row 39, so anyone whose name sorts after the last row in range gets the wrong person's numbers. | Same. |
| Kimberly header row 23 | No "Product$" header in J23, unlike every other block. | One layout for every shop. |
| LeClaire tab G2, G3 | Link to `Locations!P63` and `P64` (the total row and below), two rows too low; they should be P61 and P62. The value is 0 today, so nothing has gone wrong yet. | Each export row is written from the same line as the report row. |
| Locations, all shops | No Product$ total for Utica, Kimberly or Rock Island (section 3). | Every column has a total. |
| iSolved tabs | Key, number format, fill and font vary by tab (a text Key with `@`, General vs `0.00`, Roboto vs Arial, different widths). | Kept as they are: the exporter copies each tab's formatting cell for cell, and a test diffs it. |

## 9. Not in the workbook at all

- **Full time / part time.** Nothing in the workbook marks it. The platform derives it: full time is averaging **more than** 32 hours a week, so exactly 32.0 is part time. The hours basis and the averaging window are settings (default: clocked worked hours over a rolling 4 weeks), pending Charles.
- **Cross-shop overtime.** The workbook types OT hours by hand per shop. The platform works OT out per Sun–Sat workweek across every shop of the same legal entity and splits it by each shop's share of the hours (spec §3.2).
- **Training possibly counted twice (Q11).** The workbook exports training hours as their own earning next to the regular hours. If the clocked hours already include the training time, it's paid twice. The platform flags every training line ("training_in_hours") until Charles answers Q11. Training counts toward the weekly 40 for overtime (setting, **on** by default), but only the part that isn't already inside a clocked shift, so it's never counted twice.
