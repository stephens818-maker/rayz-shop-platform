# Staff tip payouts: Squire to Ray'z, one shop at a time (ST-C9)

Ray'z staff are hourly W-2 employees. Charles decided card tips taken on Ray'z are paid **straight to each employee's bank through Stripe** (`FEATURE_STAFF_STRIPE_PAYOUTS` on, the default). They stay W-2 wages: each direct payout goes to iSolved as tips already paid, so payroll withholds on them from regular pay. A shop can still pay **through payroll** instead (**Tip payout settings**); the steps marked **(Stripe only)** don't apply there, or anywhere the flag is `false`.

Everything below is on the shop's **Setup → Squire cutover** page unless it says otherwise. Ray'z never contacts Squire itself. Anything that needs Squire's help goes through Charles.

## Two weeks before

1. **Shop's own Stripe account (SR6).** The shop has a Ray'z connected account under **Location setup → Card payments and payouts**, with verification finished. Payouts only start once Stripe's checks pass, so start at least two weeks before the switch.
2. **Pick the switch day (SR1).** Choose the first day of a Ray'z pay period, or the day right after Squire's Wednesday Auto Payout. Avoid switching mid-period, where a barber's tips could fall between Squire's last payout and Ray'z's first payroll.
3. **Tell the team (SR7).** Barbers used to same-day debit payouts (Squire's Rapid Transfer) get card tips by Stripe, two days after the tip by default, or instantly to a debit card where the brand allows it (for Stripe's fee). Tell them the tips are still on their W-2 and taxed through their paycheck. At a shop paying through payroll, tips come with the paycheck instead.
4. **Staff app invites.** Send each person the staff app link from **Users** (the **Ray'z Staff app** row). Direct deposit for wages stays in iSolved (SR5).
5. **(Stripe only)** Send payout onboarding invites from **Payroll → Payout onboarding**. Nobody's Squire Stripe account carries over (SR5), so everyone does Stripe's hosted setup; tips wait for anyone not done.

## The switch

6. **Last day Squire pays tips.** Enter it under **Tip payouts: Squire to Ray'z**, with the last day Squire's statement covers and Squire's last payout day. The report then shows each barber's tips still owed by Squire (Squire tickets after its last statement, through that last day), Squire's last payout day and Ray'z's first payroll check date.
7. **Each barber confirms (SR1).** The staff app's payout cutover screen (`GET /me/payout-cutover`) shows them the same numbers. They confirm, or dispute with a note. A disputed amount blocks the manager's sign-off until it's settled and they confirm.
8. **Manager signs off on the report (SR1).** **Sign off the payout report** records who and when. If the numbers change afterwards (a late Squire export, a corrected date), the sign-off shows as out of date and has to be done again.
9. **Squire balances (SR2).** Squire's pending balances for the shop and its barbers stay on Squire's platform; Stripe can't move them. Before Squire processing is turned off, Charles gets written confirmation from Squire that every pending balance has been paid out. Keep Squire read-only for that shop until its balance is zero, and keep the confirmation with the shop's cutover records.
10. **Sign off and switch.** The owner signs off on the booking reconciliation (step 4 on the page). **(Stripe only)** It also waits until everyone working at the shop has finished payout setup, unless the owner types a reason.

## After the switch

11. **Year to date (SR3).** Upload each barber's 2026 tips, sales and Squire payouts as of the switch under **Year to date from Squire** (CSV). The staff app's year totals add it to Ray'z's, read-only. The CPA reconciles those figures against iSolved before year-end, so the W-2 includes every tip once. Ask whether any barber has a Stripe Express login or a 1099 from Squire for the same money; a 1099 there would double-report it.
12. **Chargebacks on Squire-era tips (SR8).** Squire handles disputes on charges it processed, including any tip on them. Ray'z doesn't take back tips for those; tell the manager to send them to Charles.
13. **W-2 vs 1099 (SR4).** Employee Stripe accounts are made so Stripe sends no 1099 (Ray'z pays their Stripe fees; the 1099 exclusions import on **Payout onboarding**, each January). Each pay period, check **Payroll → Payroll tip report** before approving: every direct payout has to be in the iSolved file as tips already paid, to the cent, or the lock is refused. Stripe and the CPA confirm the setup before live money moves (DEPLOY step 40).

## Risks and where each is handled

| Risk | Where |
| --- | --- |
| SR1 Missed payouts at cutover | Steps 2, 6, 7, 8 (`/me/payout-cutover`, the payout report and its sign-off) |
| SR2 Pending balances on Squire | Step 9 (Charles, in writing) |
| SR3 2026 tax-form continuity | Step 11 (YTD import, `/me/earnings/ytd`, CPA reconciliation) |
| SR4 W-2 vs 1099 | Step 13 (tips already paid in the iSolved file, the payroll tip report and lock check, no-1099 accounts) |
| SR5 Re-onboarding | Step 5 (Stripe's hosted setup, tips held until done) |
| SR6 Shop connected accounts | Step 1 |
| SR7 Rapid Transfer expectations | Step 3 (a decision for Charles) |
| SR8 Squire-era chargebacks | Step 12 |
