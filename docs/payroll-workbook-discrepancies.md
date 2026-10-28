# Payroll workbook discrepancies

What's wrong in the current payroll workbook (the Locations sheet and the per-shop iSolved tabs), what the platform shows instead, and why. The rows themselves are right: all 33 employee rows match Excel's cached results on 293 computed cells, with 0 mismatches, and an independent check by Testing Bot found the same. What's wrong is the **totals**, plus a few typed cells and lookups.

The platform doesn't carry any of these over. Every subtotal and grand total on the Payroll Report and in every export file is a sum of line items, and approve-and-lock is blocked if any total is even $0.01 away from the sum of its rows (see [the spec](payroll-report-spec.md#7-reconciliation-gate)).

**Anonymized:** every amount, hour and rate here comes from the anonymized copy of the workbook (`tests/fixtures/payroll-golden/anon/golden.json`): fictional names, keys, rates, hours, sales and tips on the same shops, rows, typed cells, zeros and formula ranges. Each problem shows up exactly as it does in the real workbook, but none of the figures are real. People are referred to by shop and a letter ("Coralville barber A") or as "the owner row". To see the real figures, run `scripts/payroll-golden.ts --totals` on the workbook locally; don't paste its output into the repo, a ticket or a chat.

**The totals audit (Claude bot, Oct 22)** recomputed every totals, gross profit, grand total and summary cell on the Locations sheet from the employee rows. It flagged **112 cells**:

| Finding | Cells | Sections |
| --- | --- | --- |
| A wrong value (block totals, ratios, gross profit, grand total, summary) | **71** | 1, 2, 4, 5, 10 |
| Circular: the total includes itself | 6: Utica C9, L9 and R9; Kimberly B30, C30 and R30 | 2 |
| Wrong range, but right today only because the rows it skips are 0 | 8 | 11 |
| A rate column summed (Hourly Wage, Prod%), which means nothing | 10 | 4 |
| A missing total (the column has values but no total) | 22 | 3 |
| Typed where a formula is expected | 1: F72 ("RI", cosmetic) | 8 |

The circular cells overlap the other rows (C9 and C30 are also summed rates), so the categories add up to 112 without them. **Only Moline's block is fully right**, apart from its summed wage (C20). **The per-shop iSolved tabs are right:** every column reconciles to the corrected Locations rows (section 12). Only the Locations totals are broken. The audit also covered taxes (section 13), the Squire feed (section 14), cross-shop overtime (section 15) and training hours (section 16); section 17 maps its fix list to the platform and the tests.

`tests/payroll-totals-audit.test.ts` checks every one of the 112 cells. It works out each workbook formula from the golden rows, checks that the finding is the audit's, and checks that the Payroll Report's own total is the correct value. It runs on the anonymized copy (committed) and, on machines that have it, on the real workbook's data against the audit's own `totals_findings.csv` and headline totals. The cell catalog it uses (`tests/fixtures/payroll-golden/locations-totals-formulas.json`) holds addresses and formulas only.

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
| Utica | C9 wage | `SUM(C3:C60)` | — | — | Includes itself, and sums a rate (section 4) |
| Kimberly | C30 wage | `SUM(C24:C37)` | — | — | Same |

Totals built on a circular cell are unknown too:

| Cell | Formula | Sum of rows | Cause |
| --- | --- | --- | --- |
| Kimberly F30 gross/hour | `E30/B30` | 39.2551 | Divides by the circular B30. Its cached value depends on when Excel last resolved the loop, so don't rely on it |
| B56 grand total of hours | `B55+B47+B39+B30+B20+B9` | 1,631.67 | Shows `#N/A` because it adds the circular B30. It also leaves out LeClaire's B63 entirely |

## 3. Totals that are missing

The total row leaves the cell blank, so the column has no shop total at all. All 22, including those whose rows add up to 0 today:

| Shop | Column | Sum of rows |
| --- | --- | --- |
| Utica | P9 PTO, Q9 OT hours | 0, 0 |
| Utica | S9 training hours | 2 |
| Moline | P20 PTO, Q20 OT hours, S20 training hours | 0, 0, 0 |
| Kimberly | J30 product $ (the header J23 is blank too) | 128.44 |
| Kimberly | P30 PTO | 0 |
| Kimberly | Q30 OT hours | 1.93 |
| Kimberly | S30 training hours | 3 |
| Rock Island | J39 product $ | 172.89 |
| Rock Island | P39 PTO | 0 |
| Rock Island | Q39 OT hours | 0.43 |
| Rock Island | S39 training hours | 15 |
| Silvis | J47 product $ | 90.61 |
| Silvis | P47 PTO | 0 |
| Silvis | Q47 OT hours | 0.48 |
| Silvis | S47 training hours | 12.5 |
| Coralville | J55 product $ | 116.10 |
| Coralville | S55 training hours | 0 |
| LeClaire | J63 product $ | 93.49 |
| LeClaire | S63 training hours | 7 |

Coralville and LeClaire do have PTO and OT totals, but over the wrong rows (section 11).

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
| Kimberly | O30 % of gross | `SUM(O24:O28)`, five percentages added | 335.98% |

Ratios of totals that are right in form but divide a short total (section 1), so they're wrong too. The correct value is the ratio of the corrected totals: F = ΣE ÷ ΣB, and G = O = ΣN ÷ ΣE.

| Shop | Cell | Formula | Shown | Correct |
| --- | --- | --- | --- | --- |
| Utica | F9 gross/hour | `E9/B9` | 42.5719 | 44.9537 |
| Utica | G9, O9 % of gross | `N9/E9` | 56.49% | 53.50% |
| Kimberly | O30 % of gross | (above) | 335.98% | 58.27% |
| Rock Island | F39 gross/hour | `E39/B39` | 26.2846 | 26.1123 |
| Rock Island | G39, O39 % of gross | `N39/E39` | 59.38% | 59.60% |
| Silvis | F47 gross/hour | `E47/B47` | 35.7489 | 37.8962 |
| Silvis | G47 % of gross | `N47/E47` | 56.01% | 52.25% |
| Coralville | F55 gross/hour | (above) | 81.8503 | 37.7105 |
| Coralville | G55 % of gross | `N55/E55` | 61.83% | 61.25% |
| LeClaire | F63 gross/hour | (above) | 95.8758 | 38.9379 |
| LeClaire | G63 % of gross | `N63/E63` | 17.80% | 56.40% |

On the platform, the totals row leaves Hourly Wage, Service% and Prod% blank. Gross /Hr and Total % of Gross are the ratios of the totals.

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
| **Total** | **57,348.67** | **65,190.20** | **29,046.78** | **34,359.78** | **28,301.89** | **30,830.42** |

Every shown figure above that differs from the rows is one of the 71 wrong cells: C69, G69, C72, E72, G72, C73, E73, G73, E74, G74, C75, E75 and G75, and the Total row's C76, E76 and G76. The summary has no Dubuque row (there's no Dubuque tab), and it puts LeClaire before Coralville. The platform adds a row for every shop in the run (Dubuque included) and lists them in the report order.

Each block's gross profit row (H, the row under the totals) is service minus Total Wages, so it takes on both short totals:

| Shop | Cell | Formula | Shown | Correct |
| --- | --- | --- | --- | --- |
| Utica | H10 | `E9-N9` | 4,255.46 | 4,802.62 |
| Rock Island | H40 | `E39-N39` | 1,877.97 | 2,269.96 |
| Silvis | H48 | `E47-N47` | 1,607.83 | 3,295.62 |
| Coralville | H56 | `E55-N55` | 2,204.47 | 3,421.08 |
| LeClaire | H64 | `E63-N63` | 2,800.44 | 1,485.42 (**overstated** by the short N63) |

The column-by-column numbers above are what the workbook's own formulas give once each total sums its own rows. The platform goes one step further and counts OT pay and training pay as cost (section 6).

## 6. OT pay and training pay left out of cost

Total Wages (N) is `max(hourly total, service commission) + product commission`, where the hourly total uses **regular hours only** (B = worked − OT). So the workbook leaves **all** OT pay (not just the premium) and **all** training pay out of Total Wages, Employee Cost and Gross Profit. iSolved still pays both, from the OT and Training hours in the export.

The platform adds three columns to the right of the workbook's (the export doesn't change):

- **T O.T. Pay** = 1.5 × base wage × OT hours, after the cross-shop split. iSolved computes blended OT itself, which may come out higher.
- **U Training Pay** = training hours × the employee's own flat training rate (Charles, Oct 28), its own line outside the greater-of. The rate is per employee and effective-dated on their Staff page, with Payroll setup's, then the hourly wage (flagged), as fallbacks. It's always in Labor Cost.
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
| **Total** | **34,359.78** | **2.84** | **71.25** | **39.5** | **689.12** | **35,120.15** | **30,070.05** |

Training is paid at the hourly wage here because the workbook has no training rate. On the platform each person's training rate is set on their Staff page, and the report flags training paid at the hourly wage (`no_training_rate`) until it is.

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
| Locations, all shops | No Product$ total for Kimberly, Rock Island, Silvis, Coralville or LeClaire, and no PTO, OT or Training total in most blocks (section 3). | Every column has a total. |
| Locations F72 | The summary's Rock Island label is typed as "RI"; the other rows link to the shop name (`=D7x`). Cosmetic. | Labels come from the shop's name. |
| Old `Isolved` tab | 6 totals rows: 5 show `#REF!`, and C42:H42 sums 4 stale rows. The tab is dead and isn't used for the upload. | Not reproduced. |
| iSolved tabs | Key, number format, fill and font vary by tab (a text Key with `@`, General vs `0.00`, Roboto vs Arial, different widths). | Kept as they are: the exporter copies each tab's formatting cell for cell, and a test diffs it. |

## 9. Not in the workbook at all

- **Full time / part time.** Nothing in the workbook marks it. The platform derives it: full time is averaging **more than** 32 hours a week, so exactly 32.0 is part time. The hours basis and the averaging window are settings (default: clocked worked hours over a rolling 4 weeks), pending Charles.
- **Cross-shop overtime.** The workbook types OT hours by hand per shop. The platform works OT out per Sun–Sat workweek across every shop of the same legal entity and splits it by each shop's share of the hours (spec §3.2).
- **Training possibly counted twice (Q11).** The workbook exports training hours as their own earning next to the regular hours. If the clocked hours already include the training time, it's paid twice. The platform flags every training line ("training_in_hours") until Charles answers Q11. Training counts toward the weekly 40 for overtime (setting, **on** by default), but only the part that isn't already inside a clocked shift, so it's never counted twice.

## 10. Employee Cost is still short after the sums are fixed

Fixing every range (sections 1 to 5) brings the Total Employee Cost to **34,359.78**. Two row-level problems still keep it below what iSolved pays:

| Row | What | Effect on Employee Cost | Platform |
| --- | --- | --- | --- |
| Coralville barber A, M51 | Total Wages uses the formula's NetComm (13.16), but the export's Comm Sales sends the typed 149.96 | Short by **$136.80**: 34,359.78 becomes **34,496.59** with the typed NetComm counted | The report's Total Wages and the gap are both shown, flagged "netcomm_gap". **Q17.** |
| Moline owner row, row 19 | 41.24 hours exported at $0 cost (D19 typed 0) | Short by **up to $1,113.48** (41.24 h × the row's $27 wage) if iSolved pays these hours | Flagged "owner_case"; owner pay follows the owner setting. **Q5 and Q17.** |

So the corrected Employee Cost is 34,359.78 from the rows as the workbook computes them, 34,496.59 with the typed NetComm, and up to about 35,610 if the owner's hours are paid. OT and training pay add the further 760.37 in section 6.

On the platform, NetComm (the export's Comm Sales) **includes** the typed override and Total Wages uses the computed figure, so the two never silently disagree: the gap is an anomaly on the run until Charles answers Q17. The totals audit test checks that NetComm = top-up + product commission + typed-over, and that the Employee Cost with the typed NetComm is the figure above.

## 11. Wrong range, right today

These 8 totals have the wrong range but show the right value, because every row they skip is 0 in this period. Each would go wrong the first time a skipped row has a value. The platform sums every row, so it doesn't depend on that.

| Shop | Cell | Formula | Rows skipped | Value today |
| --- | --- | --- | --- | --- |
| Silvis | L47 product total, M47 NetComm | `SUM(L43:L44)`, `SUM(M43:M44)` | 45–46 | 18.122 |
| Coralville | P55 PTO, Q55 OT hours | `SUM(P51:P51)`, `SUM(Q51:Q51)` | 52–54 | 0 |
| LeClaire | L63 product total | `SUM(L59:L61)` | 62 (and includes the title and header rows) | 7.4792 |
| LeClaire | M63 NetComm | `SUM(M59:M61)` | 62 | 196.1067 |
| LeClaire | P63 PTO, Q63 OT hours | `SUM(P59:P60)`, `SUM(Q59:Q60)` | 61–62 (both people) | 0 |

## 12. The shop tabs are right

The per-shop iSolved tabs have **no totals rows**, which is right for the upload. Every column of every tab adds up to the **corrected** Locations block (the sum of all its rows), not to the workbook's shown total. Tab C is Locations B (regular hours), D is Q (OT), E is R (tips), F is M (NetComm), G is P (PTO) and H is S (training).

| Shop | Regular hours | OT hours | Tips | NetComm | PTO | Training | Shown Locations totals that disagree |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Utica | 229.73 | 0 | 1,881.45 | 411.61 | 0 | 2 | R9 (circular); P9, Q9 and S9 missing |
| Moline | 346.48 | 0 | 2,882.16 | 1,295.28 | 0 | 0 | — (P20, Q20 and S20 missing) |
| Kimberly | 336.58 | 1.93 | 1,865.41 | 16.86 | 0 | 3 | B30 and R30 (circular); Q30 and S30 missing |
| Rock Island | 215.15 | 0.43 | 3,145.97 | 28.57 | 0 | 15 | B39, M39 and R39; Q39 and S39 missing |
| Silvis | 182.14 | 0.48 | 1,719.93 | 18.12 | 0 | 12.5 | B47 and R47; Q47 and S47 missing |
| Coralville | 234.09 | 0 | 1,288.77 | 157.09 | 0 | 0 | B55, M55 and R55 |
| LeClaire | 87.5 | 0 | 1,327.15 | 196.11 | 0 | 7 | R63 |
| **All** | **1,631.67** | **2.84** | **14,110.84** | **2,123.64** | **0** | **39.5** | |

- **NetComm split.** The tabs carry NetComm only. Across all shops it's the **top-up 1,806.53** (the sum of each person's positive service total) plus **product commission 180.31**, plus Coralville barber A's typed-over **136.80** = 2,123.64.
- **Cells typed or linked wrong** (right value today): Moline H3 and Silvis F5 are typed `0` instead of linking to Locations. LeClaire G2 and G3 link to P63 and P64 (the totals and gross profit rows) instead of P61 and P62 (section 8), so G2 would pick up any PTO total.
- **Platform.** The export is written from each person's own line, the same line as the report row, so a tab can't drift from the report. The test puts PTO on both LeClaire people and checks each lands in their own export row.

## 13. Taxes

There's **no payroll tax column** anywhere: not on Locations and not on the iSolved tabs. The only tax in the data is the **sales tax** in the Squire feed (on service and on product). The workbook doesn't use it, which is right: sales tax isn't pay, and iSolved does the payroll withholding from the exported earnings. There's nothing to reconcile.

The platform carries sales tax as a reference figure only ("Sales tax (reference)" in the report builder). It isn't a Locations column, isn't in the export, and the test checks that changing it changes no pay figure.

## 14. The Squire feed against Locations

Locations differs from the Squire feed in service, tips, hours and product, and **every gap is explained by a typed cell** in section 7. There are no unexplained differences:

- **Service and tips:** Rock Island barber A's and LeClaire barber A's typed service and tips, less the owner row's feed service, which is typed out (E19 = 0).
- **Hours:** the owner row's and Utica barber A's hours aren't from the feed at all, and Rock Island barber A's are typed above the feed.
- **Product:** the feed's "Unassigned sales" have no person, so they're in the feed total but on no row.

On the platform, hours come from time entries and sales from the POS, so these would be overrides with a reason, listed on the run.

## 15. Cross-shop overtime in this period

**Nobody is on two shop tabs** in this workbook (checked by iSolved Key and by name), and the Squire feed has one row per person with one brand-wide hours figure. So the cross-shop rule changes no OT hours this period: Kimberly 1.93, Rock Island 0.43 and Silvis 0.48 stay as they are, and per-shop overtime didn't cause an underpayment. The platform rule (hours summed per person across every shop for each Sun–Sat workweek, then split by shop) matters as soon as someone clocks in at two shops.

- **A possible hidden multi-shop case.** Rock Island barber A's hours are typed above the feed, with matching extra sales and tips; LeClaire barber A has extra sales and tips with the feed's hours. This looks like work at a second shop folded in by hand. It stays under 80 hours for the period, but if the extra hours fell in a week already near 40, some OT could be owed. That needs the weekly punches (**Q6**).
- **The typed OT is uneven.** The workbook has period totals only, so the least OT any weekly split could give is `max(0, total − 80)`. That's 0 for all three people with OT, yet they have OT typed, so whoever typed it had weekly figures with uneven weeks. The platform keeps them as typed for the golden period and works OT out from the time entries after that. The workweek start day is **Q1**.

## 16. Training hours and overtime (C2, Q11)

If the Training column is time **on top of** the clocked hours and counts as hours worked, some people's combined hours go over 80 in the period, so more OT could be owed. In the anonymized copy, the Rock Island barber on row 34 goes over by 2.43 hours. These hours are already paid once at the base rate (as regular or training), so the extra cost is the 0.5× premium on them. If training is already inside the clocked hours, it's 0. Moving hours into OT would change the upload values (not the format), and Charles has said not to change the iSolved upload, so this is for the conversation with the CPA and iSolved only. The platform's "count training toward the 40" setting (**on** by default) handles it from the time entries, never counting a training block twice (section 9).

Charles settled how training is paid (Oct 28): training hours × the person's own training rate, outside the greater-of, in Labor Cost, with training hours in `E_Training_Hours` as before. Still open for Charles and the CPA: whether training counts toward the 40 and whether it's on top of the clocked hours. Until then the setting stays on, since under the FLSA training is generally hours worked. When training on top of clocked hours goes past the 40 at a shop where the person clocked fewer hours than that shop's share of the OT, the rest of the OT comes off the training hours there, so regular hours are never negative (`training_overtime`).

## 17. The fix list and the tests

The workbook is left as it is. What the platform does for each item on the audit's fix list:

| Fix | Platform | Test |
| --- | --- | --- |
| Every block total sums all its rows; no fixed or whole-sheet ranges; no circular cells | Totals are sums of the run's lines, never ranges | `payroll-totals-audit`: the catalog and every flagged cell; `payroll-golden`: circular cells are never compared |
| Ratio totals are ratios of the totals; rates aren't totalled | F = ΣE ÷ ΣB, G = O = ΣN ÷ ΣE; Hourly Wage, Service% and Prod% blank on totals rows | `payroll-totals-audit`: Payroll Report download; `payroll-engine`: sums and ratios |
| Product$, PTO, OT and Training totals in every block | Every summed column has a total | `payroll-totals-audit`: Payroll Report download |
| Summary and grand total from the corrected blocks; a Dubuque row | Summary from the block totals, a row for every shop in the run, in the report order | `payroll-totals-audit`: the summary and Dubuque tests |
| Employee Cost includes the typed NetComm and the owner's hours as configured | The gap is a "netcomm_gap" anomaly; owner rows are "owner_case" | `payroll-totals-audit`: typed NetComm; `payroll-engine`: owner rows |
| OT per person per Chicago workweek across every shop; hours only to iSolved | Cross-shop OT split by share; the export carries OT hours, never dollars | `payroll-engine`: cross-shop overtime, DST weeks, OT hours only |
| Golden tests assert the corrected totals and list the workbook's cached ones as known bugs | The golden period's grand totals and every shop tab's totals are asserted to the cent | `payroll-totals-audit` on the anonymized copy (in CI) and on the real data where it's present (locally only) |
