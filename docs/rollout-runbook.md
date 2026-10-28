# Rollout: one pilot shop, then the rest (per-shop migration and cutover)

Charles approved this plan (Oct 28):

1. Everything is complete and tested in the sandbox first: the web platform, the customer apps and the Ray'z Staff app.
2. **One pilot shop** goes live while Squire stays as its backup.
3. **The other shops** switch after the pilot's first **clean pay period** on Ray'z.

While that runs, one pay period can mix shops: the pilot's payroll comes from Ray'z (its time clock and tickets) and the others' from Squire's data. Payroll is still one run, one review, one approval and one set of iSolved files.

Most of this is on **Setup → Rollout** (`/admin/rollout`) and **Setup → Squire cutover**. Ray'z never contacts Squire itself. Anything that needs Squire's help goes through Charles. [DEPLOY.md](../DEPLOY.md#launch-day-every-surface-at-once-at-the-pilot-shop) has the launch-day timing for the apps and the domain.

## How the flags work

Each shop has one row on the Rollout page:

| Flag | What it does |
| --- | --- |
| **Wave** | **Pilot** (one shop only) or **Second wave**. A second-wave shop can't **Sign off and switch** on Squire cutover, or be set to book **Here** in Shop settings, until the pilot's clean pay period is signed off and the pilot still books here. |
| **Planned go-live** | The date you plan to switch it. For the schedule only: nothing happens on that date by itself. |
| **Payroll from here starting** | The first pay period whose payroll comes from Ray'z. Before it, the shop's payroll comes from the Squire Commissions report imported for each period. It must be the first day of a pay period that isn't locked yet. |
| **Squire backup until** | How long Squire stays ready to take the shop back (its login, staff and booking page kept). Shown on the page; Charles decides when Squire is closed. |

Where each shop books is the **Online booking** column: it changes only on **Squire cutover** (sign-off or hand back).

- Until any shop has a row, nothing changes: every shop's payroll comes from Ray'z, as before. Once one shop has a row, a shop with no row or no **Payroll from here starting** is on Squire data. That's the safe side.
- A locked pay period keeps the source it was approved with, so changing a date later never rewrites a period already sent to iSolved.
- A shop that never ran on Squire (a new location) gets **Payroll from here starting** set to its first pay period.

## Before the pilot (every shop)

1. **Plan the rollout (Rollout page).** Set the pilot's wave to **Pilot** and the rest to **Second wave**, each with a planned go-live date and **Squire backup until**. Pick the pilot's switch day: the **first day of a pay period** (a Sunday, before it opens). Switch the evening before or that morning, so the whole period is on Ray'z. Set the pilot's **Payroll from here starting** to that pay period. Leave it empty for the second wave.
2. **Staff (Staff page).** For every person at every shop:
   - **Squire name:** exactly as it appears in Squire's reports. The Commissions report import matches on it, then on the display name or full name, then on a first name only one person at that shop has.
   - **Payroll (iSolved):** the employee number (Key) and the iSolved name (`LAST, FIRST`).
   - Their rate at each shop, or their compensation plan.
   - Each shop's pay group and iSolved code on **Payroll → Setup → Pay groups** (DEPLOY steps 48 and 49).
3. **The clients import (Squire cutover).** Run the dry run and read the shop's match report (C21). Clean up duplicates under **Clients → Duplicates → Imported from Squire**. Do this for every shop now, not just the pilot, so the second wave only needs the change since then.
4. **Staging rehearsal (C14).** Run the whole cutover for every shop on a staging copy, and have Charles sign off.

## Before the pilot (the pilot shop)

5. **The shop (two weeks before).**
   - Pair the front-desk tablet as the time clock (kiosk mode) and have everyone set a PIN (DEPLOY steps 44 and 45).
   - Register the card readers (**Shop settings → Card readers**).
   - Finish the shop's Stripe account (**Location setup → Card payments and payouts**).
   - Send the staff app invites (**Users**) and the payout onboarding invites (**Payroll → Payout onboarding**). Follow [the staff payout cutover](staff-payout-cutover.md) for tips: the last day Squire pays tips, each barber's confirmation, and the payout report sign-off.
6. **Tell the team.** From the switch day: clock in and out on the tablet; clients book on Ray'z; card tips are paid by Ray'z. Squire is still there if Ray'z has to hand the shop back, but nobody uses it for the pilot shop unless told to.

## The switch (the pilot shop)

7. **Freeze Squire.** After closing, turn off the shop's online booking in Squire and record the time on **Squire cutover**.
8. **Delta import.** Import the shop's bookings, loyalty and gift cards changed after the freeze.
9. **Reconcile.** Upload Squire's final exports and reconcile them to the cent.
10. **Sign off and switch.** An owner signs off on **Squire cutover**. The website and the apps book the shop here within a minute; the other shops still send clients to Squire.
11. **Check the Rollout page.** The pilot shows **Online booking: Here** and **From here** for the current pay period. If it shows **Squire data** for the current period, **Payroll from here starting** is wrong (step 1); fix it before the period ends. The Payroll Report flags the same thing.

## While the pilot runs (each day)

12. **Watch the pilot.** Check sign-ins, bookings, punches and payments. Fix missed punches the same day, with a reason. If one surface has a problem, use its switch rather than handing the shop back (DEPLOY "After").
13. **Squire stays the backup.** Keep the pilot's Squire account until **Squire backup until**. Don't book its clients there. The other shops keep running on Squire as normal.

## Payroll with some shops on Squire (each pay period)

14. **The pilot (from Ray'z).** After the period ends, managers approve every timesheet and lock the period on **Payroll → Timesheets**. Shops on Squire data aren't checked for timesheets.
15. **Each shop on Squire data.** In Squire, run the **Commissions** report for the pay period, **for that shop only**, and export it (CSV) or copy the table. On the Rollout page, under the shop's row (**Squire Commissions report for …**), pick the pay period and upload or paste it.
    - The report has a service block then a product block, each with its header row (Name, Hours Worked, …, Total, …, Tips, …, Tax). Import it as Squire gives it.
    - If any line has a problem (a name that matches nobody, two people with the same name, a wrong period), nothing is saved: fix the name on the Staff page, or the export, and import again.
    - Importing again replaces it, until the period is locked. The import keeps the file name, who imported it and the totals in the audit log.
    - If Squire's Commissions report can't be filtered by shop, export it with a **Shop** or **Location** column; the import keeps only that shop's lines.
16. **Review the Payroll Report.** It has every shop: shops on Squire data have a **From Squire data** badge. Approve is refused while any of them has no import for the period.
    - **Overtime, PTO and training.** Squire's report has the period's total hours only. Type each person's O.T., PTO and training hours on the report (with a reason), from Squire's timecards.
    - **Someone at a Ray'z shop and a Squire shop** for the same employer is flagged **cross-source overtime**: their weekly overtime spans both. Work out their weeks from both and type the O.T. hours.
    - **Tips:** at shops on Squire data, every tip is in `E_Cash Tips Recd` as in the payroll workbook. Squire paid the card tips out, so nothing is paid out by Ray'z for them.
    - **Rollout flag:** a shop that books here but whose period is on Squire data (or the other way round) is flagged. Fix **Payroll from here starting** before approving.
17. **Approve, upload, lock.** Approve, download each shop's iSolved file and upload it, then lock (DEPLOY step 48). Each locked period records where each shop's payroll came from.

## The clean pay period (the pilot shop)

18. **Check it.** On the Rollout page, **Pilot's clean pay period** lists the pilot's pay periods with these checks:
    - Payroll came from here (punches and tickets, not Squire data).
    - Booked here the whole period: switched by the end of the period's first day, and not handed back.
    - The period is over.
    - Approved and locked.
    - Nothing changed since the lock: no ticket, punch or import moved its figures.
    - Tips tie out to the cent: every employee's tips match the iSolved file and their payouts.
    - No commission for it paid late.
19. **Sign it off.** Once paychecks have gone out, an owner confirms what Ray'z can't check: everyone's paycheck was right, iSolved took the file, and nobody on the team had a complaint. Type it in the note (10 characters or more) and sign off. The note and the checks go in the audit log.
20. **If it isn't clean,** fix the cause and sign off the next pay period instead. The second wave waits.

## Rollback (hand back)

21. **Hand back** on **Squire cutover** returns the pilot to Squire with the bookings made here. It also clears the clean-period sign-off, so the second wave can't switch until a new one.
    - **At a pay period boundary,** if you can: set **Payroll from here starting** to a later pay period (or empty), so the next period comes from Squire data.
    - **In the middle of a period:** keep that period on Ray'z. Import the Squire days' hours on **Payroll → Hours**, with **Hours come from the time clock** off for that run (DEPLOY step 45). On the Payroll Report, type over each person's service sales, product sales and tips to add the Squire days' (from Squire's Commissions report for those days), with a reason. Then set **Payroll from here starting** to the next pay period after the shop comes back.

## The second wave

22. **Once the clean pay period is signed off,** for each shop (one at a time or together), at the first day of a pay period:
    - Set its **Payroll from here starting** to that pay period on the Rollout page.
    - Steps 5 to 11: the shop's readiness, freeze, delta import, reconcile, sign off and switch.
    - Squire stays the backup for each until its **Squire backup until** date.
23. **The last period on Squire data** for each shop is imported as in step 15. After the last shop's, nothing more is imported. Charles closes Squire once every shop's backup date has passed and Squire has confirmed every pending balance was paid out (staff payout cutover, step 9).

## Risks and where each is handled

| Risk | Where |
| --- | --- |
| A second-wave shop switches before the pilot is proven | Wave gate on **Sign off and switch** and Shop settings; the clean-period checks (steps 18–19) |
| A shop paid twice, or not at all, for a period | One source per shop and period (**Payroll from here starting**); Rollout flags on the Payroll Report (step 16); locked periods keep their source |
| A shop on Squire data left out of payroll | Approve refused until each one has an import for the period (steps 15–16) |
| Wrong person matched in Squire's report | Squire names on Staff (step 2); nothing saved on any problem (step 15) |
| Overtime missed for someone at both a Ray'z and a Squire shop | Cross-source overtime flag (step 16) |
| Tips counted twice in the changeover | The staff payout cutover's last day Squire pays tips (step 5); Squire-data tips all cash tips received (step 16) |
| The pilot has to go back to Squire | Hand back (step 21), Squire kept until its backup date (step 13) |
| The pilot's period looks clean but paychecks were wrong | The owner's note (step 19) |
| Squire's report can't be filtered by shop | A Shop or Location column (step 15); to confirm with Charles in the sandbox |
