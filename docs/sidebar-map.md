# Sidebar map

Charles asked for this map before the sidebar is rebuilt. The app still uses the groups in `src/domain/navigation.ts` (Front desk, Inventory, Campaign Center, Insights, Payroll, Setup). This page is the proposed home for each of those items. Nothing here moves a page.

Order inside a group is the order below. A person only sees a page their permissions already allow. Shop logins keep the front-desk tabs (Front desk, Calendar, Checkout, Clients, Walk-ins, Time clock, Openings, Reports).

## Front Desk

- Today — `/admin`
- Sales & checkout — `/admin/sales`
- Cash drawer — `/admin/drawer`
- Walk-ins & waitlist — `/admin/walk-ins`
- Call-ins — `/admin/call-ins`
- Gift cards — `/admin/gift-cards`
- Memberships — `/admin/memberships`
- Service menu — `/admin/services/menu`
- Inbox — `/admin/inbox`
- Phone agent — `/admin/phone-agent`
- Milestones — `/admin/milestones`

## Calendar

- Calendar — `/admin/calendar`
- All-shops day board — `/admin/calendar/board`

## Clients

- Clients — `/admin/customers`
- App sign-in help — `/admin/customers/sign-in-help`

Find a client stays on the Clients page. Booking an appointment on the calendar still picks a client there.

## Employees

- Staff & schedules — `/admin/staff`
- Time clock — `/admin/clock`
- Front-desk clock — `/admin/clock/kiosk`
- My time — `/admin/my-time`
- Time off — `/admin/time-off`
- Timesheets — `/admin/timesheets`
- Hours — `/admin/payroll/hours`
- Time clock setup — `/admin/time-clock`
- Staff milestones — `/admin/milestones/settings`
- Users — `/admin/users`
- Shop logins — `/admin/shop-logins`
- My tips — `/admin/my-tips`
- My banking — `/admin/my-banking`
- My pay — `/admin/my-pay`
- Pay questions — `/admin/pay-questions`
- Payroll report — `/admin/payroll/report`
- Payroll tip report — `/admin/payroll/tips`
- Tip payouts — `/admin/tips`
- Payout onboarding — `/admin/tips/onboarding`
- Payout tracker — `/admin/tips/tracker`
- Tip payout settings — `/admin/tips/settings`
- Final pay — `/admin/payroll/final-pay`
- Payroll setup — `/admin/payroll/setup`
- Compensation — `/admin/compensation`

Payroll, tips, and pay rates stay behind the permissions they already use.

## Inventory

- Products — `/admin/products`
- Stock — `/admin/inventory`
- Low stock — `/admin/inventory/low-stock`
- Purchase orders — `/admin/purchase-orders`
- Vendors — `/admin/vendors`
- Transfers — `/admin/inventory/transfers`
- Counts — `/admin/inventory/counts`
- Inventory settings — `/admin/inventory/settings`

## Campaigns

- We have openings — `/admin/campaign-center/openings`
- Campaigns — `/admin/campaign-center`
- Blasts — `/admin/campaign-center/blasts`
- Calendar — `/admin/campaign-center/calendar`
- Templates — `/admin/campaign-center/templates`
- My lapsed clients — `/admin/campaign-center/my-clients`
- Settings — `/admin/campaign-center/settings`

## Reports

- Morning Dashboard — `/admin/morning`
- Reports — `/admin/reports`
- Payouts — `/admin/payouts`
- Event log — `/admin/analytics`
- Morning Dashboard email — `/admin/digest`

## Brand Settings

Visible only with the brand permission that already gates the page.

- Brand defaults — `/admin/brand-defaults`
- Sync status — `/admin/sync-status`
- Permissions — `/admin/permissions`
- Permissions matrix — `/admin/permissions/matrix`
- Services — `/admin/services`
- Bulk edit — `/admin/bulk-edit`
- Bulk upload — `/admin/catalog`
- Promos — `/admin/promos`
- Taxes & card fees — `/admin/taxes`
- Credit card fee — `/admin/card-fee`
- Location setup — `/admin/setup`
- Location groups — `/admin/location-groups`
- Barber groups — `/admin/barber-groups`
- Notifications — `/admin/notifications`
- App switches — `/admin/app-switches`
- Client data protection — `/admin/client-data`
- Contact access — `/admin/client-data/contact-access`
- Client data access — `/admin/client-data/access`
- Squire import — `/admin/import`
- Squire cutover — `/admin/cutover`
- Rollout — `/admin/rollout`
- Sign-in security — `/admin/sign-in-security`

Booking links (public URL, QR, embed) are not a page yet. They would go here after this map is approved.

## Shop Settings

- Shop settings — `/admin/settings`
- Booking times — `/admin/booking-times`
- Checkout prompts — `/admin/checkout-prompts`
- Block reasons — `/admin/block-reasons`
- Picklists — `/admin/lists`
- Client messages — `/admin/messages`
- Rayz Assistant — `/admin/assistant/settings`
- Client badges — `/admin/client-badges`
