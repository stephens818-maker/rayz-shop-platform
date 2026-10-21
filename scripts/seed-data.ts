/**
 * Real Ray'z data from the Squire pulls (Oct 13 & Oct 19, 2026). Anything not in Squire is marked SAMPLE.
 */

type Hours = Partial<Record<0 | 1 | 2 | 3 | 4 | 5 | 6, [number, number]>>; // weekday -> [open, close] in hours
const std: Hours = { 1: [9, 18], 2: [9, 18], 3: [9, 19], 4: [9, 19], 5: [9, 18], 6: [8, 16] };

export interface ShopSeed {
  slug: string;
  name: string;
  address: string;
  city: string;
  state: "IA" | "IL";
  zip: string;
  phone: string | null;
  email: string | null;
  hours: Hours;
  /** SAMPLE placeholders — confirm with the accountant before go-live (tax_rates_verified=false). */
  serviceTaxRate: string;
  productTaxRate: string;
  note?: string;
}

const IA_TAX = { serviceTaxRate: "0.07", productTaxRate: "0.07" };
const IL_TAX = { serviceTaxRate: "0", productTaxRate: "0.0875" };

export const SHOPS: ShopSeed[] = [
  { slug: "coralville", name: "Coralville", address: "1701 2nd Street", city: "Coralville", state: "IA", zip: "52241", phone: "+13195196700", email: "rayzbscoralville@outlook.com", hours: { 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [9, 16] }, ...IA_TAX },
  { slug: "kimberly", name: "Kimberly", address: "1150 E Kimberly Rd #B", city: "Davenport", state: "IA", zip: "52807", phone: "+15633868505", email: "rayzbskimberly@outlook.com", hours: std, ...IA_TAX },
  { slug: "le-claire", name: "Le Claire", address: "127 N Cody Rd", city: "LeClaire", state: "IA", zip: "52753", phone: "+15632968350", email: "rayzbsleclaire@outlook.com", hours: { 2: [10, 18], 3: [10, 18], 4: [10, 18], 5: [10, 18], 6: [8, 16] }, ...IA_TAX },
  { slug: "moline", name: "Moline", address: "3002 Ave of Cities", city: "Moline", state: "IL", zip: "61265", phone: "+13097640977", email: "rayzbsmoline@outlook.com", hours: std, ...IL_TAX },
  { slug: "rock-island", name: "Rock Island", address: "3212 18th Ave", city: "Rock Island", state: "IL", zip: "61201", phone: "+13097889000", email: "rayzbsri@outlook.com", hours: { 1: [9, 18], 2: [9, 18], 3: [9, 19], 4: [9, 19], 5: [8, 18], 6: [8, 16] }, ...IL_TAX },
  {
    slug: "dubuque",
    name: "Dubuque",
    address: "4855 Asbury Rd.",
    city: "Dubuque",
    state: "IA",
    zip: "52002",
    phone: null,
    email: null,
    // Squire shows a 9-6 every-day placeholder; Sundays are closed brand-wide.
    hours: { 1: [9, 18], 2: [9, 18], 3: [9, 18], 4: [9, 18], 5: [9, 18], 6: [9, 18] },
    ...IA_TAX,
    note: "No staff yet. Squire lists state as AL (typo) and a personal email; both left blank here.",
  },
  { slug: "silvis", name: "Silvis", address: "1211 Avenue of the Cities", city: "Silvis", state: "IL", zip: "61282", phone: "+13099127826", email: "rayzbssilvis@outlook.com", hours: std, ...IL_TAX },
  { slug: "utica", name: "Utica", address: "5262 Utica Ridge Road", city: "Davenport", state: "IA", zip: "52807", phone: null, email: "Rayzbsutica@outlook.com", hours: std, ...IA_TAX },
];

/** Saved report filters the brand admin can edit under Setup → Location groups. */
export const LOCATION_GROUPS: { name: string; shops: string[] }[] = [
  { name: "Quad Cities", shops: ["kimberly", "utica", "le-claire", "moline", "rock-island", "silvis"] },
  { name: "Iowa shops", shops: ["coralville", "dubuque", "kimberly", "le-claire", "utica"] },
  { name: "Illinois shops", shops: ["moline", "rock-island", "silvis"] },
];

/** SAMPLE saved barber filters, under Setup → Barber groups. Keys are STAFF keys. */
export const BARBER_GROUPS: { name: string; staff: string[] }[] = [
  { name: "Floaters", staff: ["jamie", "daisey", "olivia-a", "taylor-a", "olivia-b"] },
  { name: "Senior barbers", staff: ["casey", "kat", "amanda", "skylar"] },
];

export const SHOP_DESCRIPTION =
  "Ray'z Barber Shop is a place where modern meets retro. Ray'z offers the original old school barbershop feel with men's modern haircutting and style techniques. Ray'z specializes in helping guyz look their best.";

export interface ServiceSeed {
  slug: string;
  name: string;
  kind: "service" | "addon";
  category: string;
  price: number; // dollars (brand master)
  duration: number;
}

// Brand master catalog. Master prices from Squire's brand list where given; others use the most common shop price.
export const SERVICES: ServiceSeed[] = [
  { slug: "rayz-cut-shampoo", name: "Ray'z Cut w/ Shampoo", kind: "service", category: "Haircuts", price: 23, duration: 40 },
  { slug: "rayz-cut", name: "Ray'z Cut (No Shampoo)", kind: "service", category: "Haircuts", price: 20, duration: 20 },
  { slug: "senior-military", name: "Senior / Military Cut", kind: "service", category: "Haircuts", price: 18, duration: 20 },
  { slug: "senior-cut", name: "Senior Cut", kind: "service", category: "Haircuts", price: 18, duration: 20 },
  { slug: "military-cut", name: "Military Cut", kind: "service", category: "Haircuts", price: 18, duration: 20 },
  { slug: "kidz-cut", name: "Kid'z Cut (8th grade & under)", kind: "service", category: "Haircuts", price: 18, duration: 20 },
  { slug: "buzz-cut", name: "Buzz Cut", kind: "service", category: "Haircuts", price: 19, duration: 15 },
  { slug: "bald-fade", name: "Bald Fade", kind: "service", category: "Fades", price: 19, duration: 40 },
  { slug: "specialty-fade", name: "Specialty Fade", kind: "service", category: "Fades", price: 37, duration: 45 },
  { slug: "gray-blending", name: "Gray Blending", kind: "service", category: "Color", price: 40, duration: 45 },
  { slug: "camo-color", name: "Men'z Camo Color", kind: "service", category: "Color", price: 30, duration: 30 },
  { slug: "womens-cut", name: "Women's Cut", kind: "service", category: "Haircuts", price: 35, duration: 40 },
  { slug: "facial-trim", name: "Facial Trim", kind: "service", category: "Beard & Face", price: 10, duration: 15 },
  { slug: "beard-trim", name: "Beard Trim", kind: "service", category: "Beard & Face", price: 5, duration: 10 },
  { slug: "beard-lineup", name: "Beard Line Up", kind: "service", category: "Beard & Face", price: 5, duration: 10 },
  { slug: "bang-trim", name: "Bang Trim", kind: "service", category: "Haircuts", price: 5, duration: 10 },
  { slug: "hot-towel-shave", name: "Hot Towel Face Shave", kind: "service", category: "Beard & Face", price: 40, duration: 30 },
  { slug: "facial-waxing", name: "Facial Waxing", kind: "service", category: "Waxing", price: 10, duration: 10 },
  { slug: "full-facial-wax", name: "Full Facial Wax", kind: "service", category: "Waxing", price: 22, duration: 20 },
  { slug: "brow-wax", name: "Brow Wax", kind: "service", category: "Waxing", price: 10, duration: 10 },
  { slug: "super-shaver", name: "Super Shaver", kind: "service", category: "Beard & Face", price: 5, duration: 10 },
  { slug: "shampoo-blowdry", name: "Shampoo w/ Blowdry", kind: "service", category: "Haircuts", price: 15, duration: 20 },
  { slug: "tinsel", name: "Tinsel", kind: "service", category: "Extras", price: 20, duration: 15 },
  { slug: "haircut-redo", name: "Haircut Re-do (within 7 days)", kind: "service", category: "Haircuts", price: 0, duration: 20 },
  { slug: "neck-trim", name: "Neck Trim", kind: "service", category: "Haircuts", price: 0, duration: 10 },
  // Add-ons
  { slug: "addon-shampoo", name: "Shampoo", kind: "addon", category: "Add-ons", price: 3, duration: 5 },
  { slug: "addon-generic", name: "Add-on Service", kind: "addon", category: "Add-ons", price: 10, duration: 10 },
  { slug: "addon-facial-trim", name: "Facial Trim", kind: "addon", category: "Add-ons", price: 10, duration: 10 },
  { slug: "addon-beard-lineup", name: "Beard Line Up", kind: "addon", category: "Add-ons", price: 5, duration: 5 },
  { slug: "addon-razor-neck", name: "Straight Razor Neck Shave", kind: "addon", category: "Add-ons", price: 3, duration: 5 },
  { slug: "addon-razor-beard", name: "Straight Razor Beard Line Up", kind: "addon", category: "Add-ons", price: 12, duration: 10 },
  { slug: "addon-tinsel", name: "Tinsel", kind: "addon", category: "Add-ons", price: 10, duration: 10 },
  { slug: "addon-shampoo-blowdry", name: "Shampoo w/ Blowdry", kind: "addon", category: "Add-ons", price: 7, duration: 10 },
  { slug: "addon-wax", name: "Wax", kind: "addon", category: "Add-ons", price: 8, duration: 5 },
  { slug: "addon-design", name: "Design", kind: "addon", category: "Add-ons", price: 5, duration: 10 },
  { slug: "addon-design-2", name: "Design 2", kind: "addon", category: "Add-ons", price: 8, duration: 15 },
];

/** [slug, price $, duration?, nameOverride?, enabled?] */
type Offer = [string, number, number?, string?, boolean?];

const coralvilleAddons: Offer[] = [
  ["addon-shampoo", 3],
  ["addon-generic", 10],
  ["addon-facial-trim", 10],
  ["addon-beard-lineup", 5],
  ["addon-razor-neck", 3],
  ["addon-razor-beard", 12],
  ["addon-tinsel", 15],
  ["addon-shampoo-blowdry", 7],
  ["addon-wax", 8],
  ["addon-design", 5, undefined, undefined, false],
  ["addon-design-2", 8, undefined, undefined, false],
];

export const MENUS: Record<string, Offer[]> = {
  coralville: [
    ["rayz-cut-shampoo", 33, undefined, "Haircut w/ Shampoo"],
    ["rayz-cut", 29, undefined, "Haircut (No Shampoo)"],
    ["kidz-cut", 26, undefined, "Kids Cut"],
    ["senior-cut", 26],
    ["military-cut", 25],
    ["buzz-cut", 24],
    ["bald-fade", 33, 40, "Skin / Bald Fade"],
    ["specialty-fade", 37],
    ["gray-blending", 40],
    ["beard-trim", 18, 20],
    ["beard-lineup", 10],
    ["full-facial-wax", 22],
    ["brow-wax", 10],
    ...coralvilleAddons,
  ],
  kimberly: [
    ["rayz-cut-shampoo", 27, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 24, 20],
    ["senior-military", 22],
    ["buzz-cut", 19],
    ["kidz-cut", 22],
    ["bald-fade", 29, 40],
    ["facial-trim", 10],
    ["beard-lineup", 5],
    ["camo-color", 30],
    ["facial-waxing", 10],
    ["super-shaver", 5],
    ["haircut-redo", 0],
    ["neck-trim", 0, undefined, undefined, false],
    ["addon-shampoo", 3],
  ],
  "le-claire": [
    ["rayz-cut-shampoo", 27, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 24],
    ["senior-military", 22],
    ["kidz-cut", 22],
    ["buzz-cut", 19],
    ["facial-trim", 10],
    ["beard-lineup", 5, undefined, "Beard Line Up or Bang Trim"],
    ["womens-cut", 27, 40, "Ladies' Haircut w/ Shampoo"],
    ["shampoo-blowdry", 15],
    ["super-shaver", 5],
    ["neck-trim", 0],
    ["facial-waxing", 10],
    ["tinsel", 20],
    ["haircut-redo", 0, undefined, "Adjust a Haircut", false],
    ["addon-shampoo", 3],
    ["addon-tinsel", 15, undefined, "Tinsel add-on to Kid'z Cut"],
    ["addon-design", 5, undefined, undefined, false],
    ["addon-design-2", 8, undefined, undefined, false],
  ],
  moline: [
    ["rayz-cut-shampoo", 26, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 23],
    ["senior-military", 21],
    ["bald-fade", 28, 40],
    ["buzz-cut", 19],
    ["kidz-cut", 21],
    ["facial-trim", 10],
    ["super-shaver", 5],
    ["haircut-redo", 0],
    ["neck-trim", 0],
    ["womens-cut", 35, 40, "Women Cut"],
    ["addon-shampoo", 3, undefined, "Add-on Shampoo"],
    ["beard-trim", 5, undefined, "Beard Trim / Bang Trim", false],
    ["hot-towel-shave", 40, undefined, undefined, false],
    ["camo-color", 30, undefined, undefined, false],
    ["facial-waxing", 10, undefined, "Wax 1 Area", false],
  ],
  "rock-island": [
    ["rayz-cut-shampoo", 25, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 22],
    ["senior-military", 20],
    ["bald-fade", 22, 40],
    ["kidz-cut", 20],
    ["buzz-cut", 19],
    ["facial-trim", 10],
    ["beard-trim", 5],
    ["facial-waxing", 10, undefined, "Waxing"],
    ["neck-trim", 0],
    ["haircut-redo", 0, undefined, "Adjusted Haircut (within 7 days)"],
    ["womens-cut", 22, 40, "Women's Haircut"],
    ["bang-trim", 5],
    ["addon-shampoo", 3, undefined, "Add-on Shampoo"],
    ["super-shaver", 5, undefined, undefined, false],
    ["camo-color", 30, undefined, undefined, false],
  ],
  silvis: [
    ["rayz-cut-shampoo", 26, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 23],
    ["bald-fade", 23, 40],
    ["senior-military", 21],
    ["kidz-cut", 21],
    ["buzz-cut", 19],
    ["womens-cut", 23, undefined, "Women's Haircut"],
    ["facial-trim", 10],
    ["beard-trim", 5],
    ["facial-waxing", 10, undefined, "Wax 1 Area"],
    ["camo-color", 30],
    ["super-shaver", 5],
    ["haircut-redo", 0, undefined, "Re-do / Adjusted Haircut"],
    ["addon-shampoo", 3],
  ],
  utica: [
    ["rayz-cut-shampoo", 27, 40, "Full Service Ray'z Cut w/ Shampoo"],
    ["rayz-cut", 24],
    ["bald-fade", 29, 40, "Bald Fade w/ Super Shaver"],
    ["senior-military", 22],
    ["kidz-cut", 22],
    ["buzz-cut", 19],
    ["beard-trim", 5],
    ["facial-trim", 10],
    ["camo-color", 30, undefined, "Camo Color for Men"],
    ["facial-waxing", 10],
    ["super-shaver", 5],
    ["haircut-redo", 0, undefined, "Adjust a Haircut"],
    ["neck-trim", 0],
    ["addon-shampoo", 3, undefined, undefined, false],
  ],
  // Not set up in Squire. Brand defaults so the shop is ready when staff are hired.
  dubuque: [
    ["rayz-cut-shampoo", 23],
    ["rayz-cut", 20],
    ["senior-military", 18],
    ["kidz-cut", 18],
    ["bald-fade", 19, 40],
    ["buzz-cut", 19],
    ["womens-cut", 35],
    ["addon-shampoo", 3],
  ],
};

export interface StaffSeed {
  key: string;
  firstName: string;
  displayLabel: string;
  squireName?: string;
  /** Shops the barber is listed at in Squire. */
  listedAt: string[];
  /** Weekly schedule: shop -> weekdays (uses that shop's hours). SAMPLE: Squire doesn't expose shifts. */
  schedule: Record<string, number[]>;
  active?: boolean;
  bookable?: boolean;
  /** Role template key; barber when unset. */
  role?: "brand_owner" | "shop_manager" | "barber";
  /** The one shop a shop manager has access to. */
  managerShop?: string;
  email?: string;
  note?: string;
}

export const STAFF: StaffSeed[] = [
  // Coralville
  { key: "michelle", firstName: "Michelle", displayLabel: "Michelle", listedAt: ["coralville"], schedule: { coralville: [1, 2, 3, 4, 5] }, role: "shop_manager", managerShop: "coralville", email: "michelle@rayz.test" },
  { key: "makenna", firstName: "Makenna", displayLabel: "Makenna", listedAt: ["coralville"], schedule: { coralville: [2, 3, 4, 5, 6] }, email: "makenna@rayz.test" },
  { key: "delaney", firstName: "Delaney", displayLabel: "Delaney", listedAt: ["coralville"], schedule: { coralville: [1, 3, 5, 6] } },
  { key: "jessica", firstName: "Jessica", displayLabel: "Jessica", listedAt: ["coralville"], schedule: { coralville: [1, 2, 4, 6] } },
  { key: "leilah", firstName: "Leilah", displayLabel: "Leilah", listedAt: ["coralville"], schedule: {}, active: false, note: "Had Coralville sales but is no longer on the barber list." },
  // Floats at 7 shops; only real sales at Le Claire.
  { key: "casey", firstName: "Casey", displayLabel: "Casey", listedAt: ["coralville", "kimberly", "le-claire", "moline", "rock-island", "silvis", "utica"], schedule: { "le-claire": [2, 3] } },
  // Kimberly
  { key: "beth", firstName: "Beth", displayLabel: "Beth", listedAt: ["kimberly"], schedule: { kimberly: [1, 2, 3, 4, 5] } },
  { key: "olivia-a", firstName: "Olivia", displayLabel: "Olivia A.", squireName: "Olivia A", listedAt: ["kimberly", "utica", "le-claire"], schedule: { kimberly: [1, 2, 3], utica: [4, 5] } },
  { key: "sammie", firstName: "Sammie", displayLabel: "Sammie", listedAt: ["kimberly"], schedule: { kimberly: [2, 3, 4, 5, 6] } },
  { key: "maddie", firstName: "Maddie", displayLabel: "Maddie", listedAt: ["kimberly"], schedule: { kimberly: [1, 3, 4, 6] } },
  { key: "ali", firstName: "Ali", displayLabel: "Ali", listedAt: ["kimberly"], schedule: { kimberly: [1, 2, 5] } },
  { key: "taylor-a", firstName: "Taylor", displayLabel: "Taylor A.", squireName: "Taylor A", listedAt: ["rock-island", "kimberly", "silvis", "utica"], schedule: { "rock-island": [1, 2, 3, 4], kimberly: [6] } },
  { key: "taylor-b", firstName: "Taylor", displayLabel: "Taylor B.", squireName: "Taylor B", listedAt: ["rock-island", "kimberly"], schedule: { "rock-island": [2, 3, 4, 5, 6] } },
  { key: "daisey", firstName: "Daisey", displayLabel: "Daisey", listedAt: ["utica", "le-claire", "kimberly", "moline", "rock-island"], schedule: { utica: [1, 2, 3, 4], "le-claire": [5, 6] } },
  // Le Claire
  { key: "skylar", firstName: "Skylar", displayLabel: "Skylar", listedAt: ["le-claire", "rock-island", "silvis", "utica"], schedule: { "le-claire": [2, 3, 4, 5, 6] } },
  { key: "audra", firstName: "Audra", displayLabel: "Audra", listedAt: ["le-claire", "utica"], schedule: { "le-claire": [2, 3, 4, 5] } },
  { key: "jamie", firstName: "Jamie", displayLabel: "Jamie", listedAt: ["moline", "le-claire"], schedule: { moline: [1, 2, 3, 4, 5], "le-claire": [6] } },
  { key: "em", firstName: "Em", displayLabel: "Em", listedAt: ["utica", "le-claire"], schedule: { utica: [1, 2, 3, 4, 5] } },
  // Moline
  { key: "jilane", firstName: "Jilane", displayLabel: "Jilane", listedAt: ["moline"], schedule: { moline: [1, 2, 3, 4, 5] } },
  { key: "mackenzie", firstName: "Mackenzie", displayLabel: "Mackenzie", listedAt: ["moline"], schedule: { moline: [2, 3, 4, 5, 6] } },
  { key: "kat", firstName: "Kat", displayLabel: "Kat", listedAt: ["moline", "rock-island", "silvis"], schedule: { moline: [1, 2, 3, 6] } },
  { key: "jen", firstName: "Jen", displayLabel: "Jen", listedAt: ["moline"], schedule: { moline: [1, 4, 5, 6] } },
  { key: "sara", firstName: "Sara", displayLabel: "Sara", listedAt: ["moline"], schedule: { moline: [2, 3, 4] } },
  // Rock Island
  { key: "garrett", firstName: "Garrett", displayLabel: "Garrett", listedAt: ["rock-island"], schedule: { "rock-island": [1, 2, 3, 4, 5] } },
  { key: "mercedez", firstName: "Mercedez", displayLabel: "Mercedez", listedAt: ["rock-island"], schedule: { "rock-island": [2, 3, 4, 5, 6] } },
  { key: "charles", firstName: "Charles", displayLabel: "Charles", listedAt: ["rock-island"], schedule: {}, bookable: false, note: "$60 in 90 days — likely owner/test account." },
  { key: "autumn", firstName: "Autumn", displayLabel: "Autumn", listedAt: ["rock-island"], schedule: {} },
  { key: "amanda", firstName: "Amanda", displayLabel: "Amanda", listedAt: ["silvis", "rock-island"], schedule: { silvis: [1, 2, 3, 4, 5] } },
  // Silvis
  { key: "olivia-b", firstName: "Olivia", displayLabel: "Olivia B.", squireName: "Olivia B", listedAt: ["silvis", "utica"], schedule: { silvis: [1, 2, 3, 4], utica: [6] } },
  { key: "abigail", firstName: "Abigail", displayLabel: "Abigail", listedAt: ["silvis"], schedule: { silvis: [2, 3, 4, 5, 6] } },
  { key: "liv", firstName: "Liv", displayLabel: "Liv", listedAt: ["silvis"], schedule: { silvis: [1, 3, 5, 6] } },
  // Utica
  { key: "sarah", firstName: "Sarah", displayLabel: "Sarah", listedAt: ["utica"], schedule: { utica: [1, 2, 3, 4, 5] } },
  { key: "kate", firstName: "Kate", displayLabel: "Kate", listedAt: ["utica"], schedule: { utica: [2, 3, 4, 5, 6] } },
  { key: "lindsay", firstName: "Lindsay", displayLabel: "Lindsay", listedAt: ["utica"], schedule: { utica: [1, 3, 4, 6] } },
  // Owner (Brand Owner, not bookable)
  { key: "owner", firstName: "Ray", displayLabel: "Owner", listedAt: [], schedule: {}, bookable: false, role: "brand_owner", email: "owner@rayz.test" },
];

/** Extra demo logins for trying the permission templates. Inserted after the sample history so it doesn't change. */
export const DEMO_LOGINS: { firstName: string; displayLabel: string; email: string; role: "brand_admin" | "regional_manager" | "front_desk"; shops: string[] }[] = [
  { firstName: "Dana", displayLabel: "Dana (admin)", email: "admin@rayz.test", role: "brand_admin", shops: [] },
  { firstName: "Reggie", displayLabel: "Reggie (regional)", email: "regional@rayz.test", role: "regional_manager", shops: ["moline", "rock-island"] },
  { firstName: "Frankie", displayLabel: "Frankie (desk)", email: "frontdesk@rayz.test", role: "front_desk", shops: ["coralville"] },
];

export const COLORS = ["#ef4444", "#f97316", "#f59e0b", "#84cc16", "#22c55e", "#14b8a6", "#06b6d4", "#3b82f6", "#6366f1", "#8b5cf6", "#d946ef", "#ec4899"];

/** SAMPLE retail catalog modeled on Coralville's brands and price band ($12–27, ~50% margin). */
export const PRODUCTS: [brand: string, name: string, price: number, category: string][] = [
  ["Reuzel", "Blue Pomade 4oz", 22, "Styling"],
  ["Reuzel", "Pink Pomade 4oz", 22, "Styling"],
  ["Reuzel", "Red Water Soluble Pomade 4oz", 22, "Styling"],
  ["Reuzel", "Fiber 4oz", 22, "Styling"],
  ["Reuzel", "Matte Clay 4oz", 22, "Styling"],
  ["Reuzel", "Grooming Tonic", 24, "Styling"],
  ["Reuzel", "Beard Balm", 20, "Beard"],
  ["Reuzel", "Daily Shampoo", 18, "Hair Care"],
  ["Johnny B", "Mode Styling Gel", 15, "Styling"],
  ["Johnny B", "Hold Up Pomade", 16, "Styling"],
  ["Johnny B", "Texture Paste", 16, "Styling"],
  ["Level 3", "Styling Powder", 16, "Styling"],
  ["Level 3", "Pliable Paste", 18, "Styling"],
  ["Level 3", "Styling Gel", 14, "Styling"],
  ["Paul Mitchell", "Tea Tree Special Shampoo", 18, "Hair Care"],
  ["Paul Mitchell", "Tea Tree Shaping Cream", 20, "Styling"],
  ["Redken", "Brews Clean Hold Pomade", 20, "Styling"],
  ["Redken", "Brews Daily Shampoo", 19, "Hair Care"],
  ["Redken", "Brews Maneuver Cream", 20, "Styling"],
  ["Gibs", "Grizzly Adams Beard Oil", 24, "Beard"],
  ["Gibs", "Beard Wash", 20, "Beard"],
  ["Gibs", "Mustache Wax", 14, "Beard"],
  ["STMNT", "Grooming Spray", 27, "Styling"],
  ["STMNT", "Fiber Paste", 25, "Styling"],
  ["STMNT", "All-In-One Cleanser", 25, "Hair Care"],
  ["Ray'z", "Snapback Hat", 25, "Merch"],
  ["Ray'z", "Beanie", 20, "Merch"],
  ["Ray'z", "Pocket Comb", 12, "Merch"],
];

export const FIRST_NAMES = [
  "Jake", "Tyler", "Mason", "Logan", "Ethan", "Noah", "Liam", "Carter", "Owen", "Wyatt", "Hunter", "Brody", "Caleb", "Dylan", "Austin",
  "Connor", "Cole", "Gavin", "Isaac", "Jackson", "Luke", "Nate", "Ryan", "Sam", "Trevor", "Zach", "Brandon", "Chase", "Drew", "Eli",
  "Grant", "Henry", "Jason", "Kyle", "Marcus", "Miles", "Parker", "Reid", "Shane", "Tanner", "Travis", "Wes", "Aiden", "Ben", "Cody",
  "Derek", "Evan", "Gabe", "Ian", "Jordan", "Kevin", "Matt", "Nick", "Paul", "Rob", "Steve", "Tom", "Vince", "Will", "Emma", "Ava",
  "Mia", "Lily", "Harper", "Ella", "Grace", "Chloe", "Zoe", "Nora",
];
export const LAST_NAMES = [
  "Anderson", "Becker", "Carlson", "Dvorak", "Erickson", "Fischer", "Gibson", "Hansen", "Iverson", "Jensen", "Kramer", "Larson", "Meyer",
  "Nelson", "Olson", "Peterson", "Quinn", "Reiter", "Schmidt", "Thompson", "Uhl", "Vogel", "Weber", "Young", "Zimmerman", "Brandt",
  "Coleman", "Decker", "Engel", "Foster", "Graham", "Hoffman", "Jacobs", "Klein", "Lund", "Murphy", "Novak", "Ortiz", "Price", "Roth",
];
