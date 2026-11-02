import type { Permission } from "./permissions";

/** One handbook topic. Empty `needs` means any signed-in staff member. */
export interface HandbookTopic {
  slug: string;
  title: string;
  keywords: string;
  needs: Permission[];
  steps: string[];
}

/**
 * Staff handbook. The same words live in docs/handbook so they can be edited as markdown.
 * Topics with `needs` stay out of search and the Help page unless the person has one of those permissions.
 * Nothing here states pay rates, tax rates, or how a paycheck is calculated.
 */
export const HANDBOOK: HandbookTopic[] = [
  {
    slug: "sign-in",
    title: "Sign in",
    keywords: "login password lockout security authenticator",
    needs: [],
    steps: [
      "Open the staff sign-in page and use the email on your account.",
      "If the shop asks for a second step, use the authenticator app on your phone.",
      "A shared shop login is for the front desk at that shop. It opens Checkout.",
      "Sign out from the bottom of the sidebar when you leave the computer.",
    ],
  },
  {
    slug: "calendar",
    title: "Calendar and booking",
    keywords: "appointment book schedule barber column",
    needs: [],
    steps: [
      "Open Calendar. Each column is one barber for the day.",
      "To book, pick an open time, the service, and the client. The calendar still lets you pick a client there.",
      "Find a client by name from the Clients page, or from Search.",
      "A future visit needs a deposit before it can be checked out.",
    ],
  },
  {
    slug: "check-in",
    title: "Check in and the timer",
    keywords: "start chair finish checkout elapsed arrived in service",
    needs: [],
    steps: [
      "Check in when the client arrives. That records the arrival time.",
      "Tap Start when they sit down. The panel shows a running timer and the booked length.",
      "A second Start says the time it already started, so you can see it took.",
      "Finish, or send them to checkout, records the end. A manager can correct a time; that correction is logged.",
    ],
  },
  {
    slug: "texting",
    title: "Texting a client",
    keywords: "sms message inbox reply stop opt in thread",
    needs: ["clients.message", "inbox.view"],
    steps: [
      "Texts stay off until the client agrees. A number that replied STOP cannot be texted until it replies START.",
      "On the calendar, open the appointment and open Messages to the client. You see the thread, not the phone number.",
      "You can answer a client who texted the shop in the last day, even before they opt in to marketing texts.",
      "The sandbox does not send a real text. The message sits in the outbox.",
    ],
  },
  {
    slug: "time-clock",
    title: "Time clock",
    keywords: "punch pin kiosk hours clock in",
    needs: ["timeclock.punch", "timeclock.kiosk", "timesheet.own"],
    steps: [
      "Clock in and out on Time clock, or at the front-desk clock with your PIN.",
      "My time shows your own punches.",
      "A missed punch is fixed on the timesheet by someone allowed to edit it. The change is logged.",
    ],
  },
  {
    slug: "my-pay",
    title: "My pay and tips",
    keywords: "tips paycheck earnings my pay payout",
    needs: ["compensation.own", "tips.own", "payroll.run", "report.tips_payroll.view"],
    steps: [
      "My pay shows your own hours, commission, and tips. It does not show anyone else's.",
      "My tips is the same idea for tip payouts you are allowed to see.",
      "People who run payroll use the payroll pages. Those pages stay behind their own permission.",
      "Ask a manager if a number looks wrong. Do not text a client's card or bank details.",
    ],
  },
  {
    slug: "clients",
    title: "Clients",
    keywords: "customer phone email visit opt in preferred barber",
    needs: [],
    steps: [
      "Clients lists name, phone, email, visits, last visit, preferred barber, and whether texts and email are on.",
      "The A to Z letters filter by the first letter of the first name.",
      "Open a name for the full profile. Phone and email follow the privacy rules for your login.",
    ],
  },
  {
    slug: "inventory",
    title: "Inventory counts",
    keywords: "stock lost damaged theft expired back bar shrink count correction",
    needs: ["inventory.manage", "inventory.adjust", "inventory.stocktake"],
    steps: [
      "Open Stock, pick the product, and adjust the count.",
      "Pick a reason: Lost, Broken / damaged, Theft, Back bar / shop use, Count correction, Expired, Found, or Other.",
      "Other needs a note. The ledger stores who changed it, when, and the new count.",
    ],
  },
  {
    slug: "campaigns",
    title: "Campaigns",
    keywords: "openings blast marketing text email",
    needs: ["campaign_center.view", "campaign_center.openings", "campaign_center.own_clients"],
    steps: [
      "We have openings tells opted-in clients that a barber has time. It does not list who received it.",
      "Other campaigns, blasts, and templates are for people the brand has allowed to send them.",
      "A client who has not agreed to texts is left out.",
    ],
  },
  {
    slug: "settings",
    title: "Shop and brand settings",
    keywords: "hours services tax fee location brand",
    needs: ["settings.shop", "settings.brand"],
    steps: [
      "Shop settings cover this location: hours, messages, and checkout prompts.",
      "Brand settings cover every shop: services, permissions, taxes, and the card fee. Only people with that permission see them.",
      "Leave a tax rate blank until you know the real one. Do not copy a rate from another shop.",
    ],
  },
];

export function handbookFor(perms: ReadonlySet<Permission>): HandbookTopic[] {
  return HANDBOOK.filter((t) => t.needs.length === 0 || t.needs.some((p) => perms.has(p)));
}
