# Launch test plan: build status by case

Testing Bot's 235-case plan is the launch acceptance bar: every P0 must pass in the sandbox before the pilot shop goes live. This file tracks what the build does for each case the plan marks as a gap or not built, and the resolutions Charles gave for its §6 items on Oct 28. It uses case IDs only; the plan itself isn't in the repo.

**Status words:**
- **Ready** means it's built, with unit or database tests, and can be run in the sandbox.
- **Fixed (Oct 28)** means the plan found a gap or a bug, and it's built now.
- **Setting** means the behavior is a setting whose default waits on Charles; the case notes which value to test.
- **Open** means a decision is still needed.

The sandbox is the PR's branch alias (see the PR's Sandbox section). Every demo login in plan §2.1 and the four accounts in §2.2 (`apprentice.test@`, `bookkeeper.test@`, `frontdesk2.test@`, `barber2.test@`) exist there with the usual demo password; `scripts/test-plan-logins.ts` adds the §2.2 ones on every demo build. The second Brand Owner (§2.2) is created by the tester, as the plan says.

## §3 P0 smoke list

| # | Cases | Status | Notes |
|---|---|---|---|
| 1 | SY-01, SY-02 | Ready | Vercel Authentication on; demo mode runs cards on the simulator |
| 2 | BA-01, FD-01, BR-01, RM-01 | Fixed (Oct 28) | Every §2.1 and §2.2 login signs in on the sandbox (checked Oct 28). FD-01: the shop login's header says "Shared shop login" again |
| 3 | CU-01, CU-20 | Ready | The booking form's text and email boxes start unchecked |
| 4 | SM-10, FD-20 | Ready | |
| 5 | FD-21, FD-22 | Ready | |
| 6 | BA-40, FD-26 | Ready | |
| 7 | SM-20, FD-40 | Ready | Front Desk has no refund permission; a shop login needs a manager's PIN |
| 8 | FD-30, FD-31 | Ready | Cash plus card on one ticket is built (G-20) |
| 9 | CU-21, CU-22 | Fixed (Oct 28) | A client's own opt-out is never lifted by a later booking, staff edit, web guest record or import (G-8) |
| 10 | BR-10, BR-11, BR-40 | Ready | |
| 11 | SM-50, SM-51 | Ready | |
| 12 | BA-30, BA-31 | Ready | |
| 13 | SM-52 | Fixed (Oct 28) | Shop and Regional Manager templates have no tips or payroll access unless granted (G-10, `core_0139`) |
| 14 | BA-50, BA-51 (and BA-52) | Fixed (Oct 28) | Bulk upload keeps its dry run, and now each saved upload has a one-step undo (G-3, `core_0140`) |
| 15 | FD-60, SM-60 | Ready | Notes follow the client to every shop; manager-only notes stay restricted (G-5) |
| 16 | CU-40, CU-41 | Fixed (Oct 28) | Public pages, the API and now marketing messages use the barber's display label (G-4) |
| 17 | CU-50, SM-70, BA-70 | Ready | Sunday hours need `settings.brand`, which is owner-only |
| 18 | BK-10, BK-12, BK-13 | Ready | |
| 19 | BK-20 | Ready | Was expected to fail. The per-shop files are exactly the workbook's 8 columns, and the golden tests match the workbook's tabs cell for cell, Roboto included (G-13, G-14) |
| 20 | BA-80 | Ready | `FEATURE_TIP_TO_BARBER=false` brand-wide, or the brand setting **Tips to barbers** off for picked shops (G-2). It's on in the sandbox, so turn a shop off first |
| 21 | SA-20, BR-30 | Fixed (Oct 28) | Was expected to fail. The time clock exists, times read in 12-hour format, and the hour that happens twice on Nov 1 reads "1:30 AM CDT" and "1:30 AM CST" (G-23) |
| 22 | SY-10 | Ready | |

## Payroll cases (plan §4.7)

| Cases | Status | Notes |
|---|---|---|
| PY-OT-01, PY-OT-02 | Ready | Cross-shop OT by hours within a pay period (`tests/payroll-engine.test.ts`) |
| PY-OT-03 | Fixed (Oct 28) | OT over the whole Sun–Sat workweek. A week straddling two periods (a Wednesday workweek start) puts the OT in the period holding the hours past the 40th, in date order. A locked period keeps its OT, and the open period takes the difference (G-15) |
| PY-OT-04 | Fixed (Oct 28) | Explicit test: the Nov 1–14 period starts on the fall-back Sunday; 9 PM CDT to 3 AM CST is 7 real hours, 3 and 4; the week is 40.00 with no OT; the repeated hour reads with its zone |
| PY-OT-05, PY-OT-06 | Ready | Explicit tests added Oct 28 |
| PY-LC-01 | Fixed (Oct 28) | OT pay is in labor cost, and the golden files carry it: the brand Employee Cost on the Payroll Report reconciles to the plan's figure on the private golden data (tested there, not committed), and to the anonymized copy's own figure in CI (G-16) |
| PY-LC-02 | Ready | OT goes out as hours only; still exactly 8 columns |
| PY-LC-03 | Fixed (Oct 28) | Q11 answered: training is on top of clocked hours and counts toward each workweek's 40 across shops. Labor cost includes Training Cost (training pay plus its share of OT pay), and the gate checks it. 38 production + 4 training = 2 OT, also with the training at a second shop (`payroll-training-ot`, `db/training-overtime`). The FLSA basis is for the CPA to confirm |
| PY-RG-01 to PY-RG-03 | Ready | |
| PY-FX-01 to PY-FX-03 | Ready | Per-tab copy of the workbook: number formats, fills, fonts (Roboto on the tabs that use it), the Key cell types (G-14) |
| PY-EX-01, PY-EX-02 | Ready | Download only; no iSolved API |
| PY-FT-01, PY-FT-02 | Ready | Full-time is more than 32.00 hours a week |
| PY-FT-03 | Setting | A rolling 4 weeks of worked hours, a brand setting, pending Charles (G-17) |
| PY-RD-01, PY-RD-02 | Setting | The export is unrounded by default (today's workbook) until Q4. Turn on **Round export to 2 decimals, half-up** under Payroll → Setup to run these |
| PY-RD-03 | Ready | Unrounded is the default |
| PY-IM-01 | Ready | |
| Sunday punch (G-11) | Fixed (Oct 28) | A Sunday punch counts in the workweek that starts that Sunday, and the Payroll Report flags it at a shop closed Sundays (`sunday_punch`) |

## Plan §6: Charles's resolutions (Oct 28)

| # | Resolution | Status |
|---|---|---|
| G-1 | Apprentice and Bookkeeper are editable role templates. Apprentice is Barber less checkout discounts, price changes, refunds and voids. Bookkeeper is read-only: reports and payroll, no POS or settings | Fixed (`core_0139`) |
| G-2 | The tip payout flag is a real brand setting with brand sync's shop picker | Ready (`core_0136`, `core_0138`) |
| G-3 | Brand sync rollback is required, not just preview | Fixed: one-step undo in sync history, and now for catalog bulk uploads too (`core_0140`) |
| G-4 | First names on customer-facing and marketing surfaces; on a collision, a brand-set display label (an initial or a nickname), editable | Fixed: marketing now uses the label too |
| G-5 | Client notes follow the client to every shop | Ready |
| G-6 | Quiet hours: send only 9 AM to 8 PM in the recipient's local time | Fixed: marketing, reminders, rebook and no-show texts, review requests and calls |
| G-7 | Reminder consent | Open: as before, a client who never answered is opted out |
| G-8 | TCPA: no pre-checked opt-in, and opt-outs never overwritten | Fixed |
| G-9 | Stripe I10: separate charges and transfers, recipient accounts | Ready |
| G-10 | Shop and Regional Manager templates don't see payroll or tips by default; only an explicit grant | Fixed (`core_0139`) |
| G-11 | A Sunday punch counts in the workweek starting that Sunday, and is flagged | Fixed |
| G-12 | Hours come from the built-in time clock at launch, not iSolved Time | Ready; README updated |
| G-13 | Exactly the 8 workbook columns, no separate tip codes | Fixed: tips owed through payroll are in `E_Cash Tips Recd_Dollars` too, and flagged (`tips_in_payroll_memo`); see Open questions |
| G-14 | An exact per-tab copy of the workbook, Roboto included | Ready |
| G-15 | OT per Sun–Sat workweek; hours belong to the period of the day worked; OT to the period with the hours past 40 | Fixed |
| G-16 | Golden files regenerated with OT pay in labor cost, and (Q11) training cost too | Fixed (`core_0146`) |
| G-17 | FT/PT: a rolling 4 weeks of worked hours, a brand setting, pending Charles | Ready |
| G-23 | Zone label where times cross DST | Fixed for the repeated fall-back hour; a skipped spring-forward time can't be typed |
| G-25 | Test the Nov 1 fall-back pay period explicitly | Fixed (PY-OT-04) |

## Open questions

- With exactly 8 columns, tips owed through payroll (the fallback for someone Stripe can't pay yet) sit in `E_Cash Tips Recd_Dollars`, a memo earning iSolved doesn't pay in the check. They're flagged on the Payroll Report, but approve-and-lock still marks them paid. Should that fallback be cash at the desk, or may one paid earning code be added?
- Should a shop login's read-only staff list be blocked on a manager role too?
- Should shops take single-booking deposits (Squire's Deposits report)?
