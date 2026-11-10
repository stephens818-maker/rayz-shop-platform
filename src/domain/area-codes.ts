/**
 * A US number's state and time zone, by area code: how the recipient's local time is told for quiet
 * hours. Numbers move with people, so this is the usual best guess the rules allow; callers keep the
 * shop's zone as a second check. Area codes split across zones use the zone most of their numbers are in.
 */
const STATES: Record<string, readonly number[]> = {
  AL: [205, 251, 256, 334, 659, 938],
  AK: [907],
  AZ: [480, 520, 602, 623, 928],
  AR: [327, 479, 501, 870],
  CA: [209, 213, 279, 310, 323, 341, 350, 369, 408, 415, 424, 442, 510, 530, 559, 562, 619, 626, 628, 650, 657, 661, 669, 707, 714, 747, 760, 805, 818, 820, 831, 840, 858, 909, 916, 925, 949, 951],
  CO: [303, 719, 720, 970, 983],
  CT: [203, 475, 860, 959],
  DC: [202, 771],
  DE: [302],
  FL: [239, 305, 321, 324, 352, 386, 407, 448, 561, 645, 656, 689, 727, 728, 754, 772, 786, 813, 850, 863, 904, 941, 954],
  GA: [229, 404, 470, 478, 678, 706, 762, 770, 912, 943],
  HI: [808],
  IA: [319, 515, 563, 641, 712],
  ID: [208, 986],
  IL: [217, 224, 309, 312, 331, 447, 464, 618, 630, 708, 730, 773, 779, 815, 847, 861, 872],
  IN: [219, 260, 317, 463, 574, 765, 812, 930],
  KS: [316, 620, 785, 913],
  KY: [270, 364, 502, 606, 859],
  LA: [225, 318, 337, 504, 985],
  MA: [339, 351, 413, 508, 617, 774, 781, 857, 978],
  MD: [227, 240, 301, 410, 443, 667],
  ME: [207],
  MI: [231, 248, 269, 313, 517, 586, 616, 679, 734, 810, 906, 947, 989],
  MN: [218, 320, 507, 612, 651, 763, 952],
  MO: [235, 314, 417, 557, 573, 636, 660, 816, 975],
  MS: [228, 601, 662, 769],
  MT: [406],
  NC: [252, 336, 472, 704, 743, 828, 910, 919, 980, 984],
  ND: [701],
  NE: [308, 402, 531],
  NH: [603],
  NJ: [201, 551, 609, 640, 732, 848, 856, 862, 908, 973],
  NM: [505, 575],
  NV: [702, 725, 775],
  NY: [212, 315, 329, 332, 347, 363, 516, 518, 585, 607, 624, 631, 646, 680, 716, 718, 838, 845, 914, 917, 929, 934],
  OH: [216, 220, 234, 283, 326, 330, 380, 419, 436, 440, 513, 567, 614, 740, 937],
  OK: [405, 539, 572, 580, 918],
  OR: [458, 503, 541, 971],
  PA: [215, 223, 267, 272, 412, 445, 484, 570, 582, 610, 717, 724, 814, 835, 878],
  PR: [787, 939],
  RI: [401],
  SC: [803, 821, 839, 843, 854, 864],
  SD: [605],
  TN: [423, 615, 629, 731, 865, 901, 931],
  TX: [210, 214, 254, 281, 325, 346, 361, 409, 430, 432, 469, 512, 682, 713, 726, 737, 806, 817, 830, 832, 903, 915, 936, 940, 945, 956, 972, 979],
  UT: [385, 435, 801],
  VA: [276, 434, 540, 571, 686, 703, 757, 804, 826, 948],
  VT: [802],
  WA: [206, 253, 360, 425, 509, 564],
  WI: [262, 274, 353, 414, 534, 608, 715, 920],
  WV: [304, 681],
  WY: [307],
};

const EASTERN = ["CT", "DC", "DE", "FL", "GA", "IN", "MA", "MD", "ME", "MI", "NC", "NH", "NJ", "NY", "OH", "PA", "RI", "SC", "VA", "VT", "WV"];
const MOUNTAIN = ["CO", "ID", "MT", "NM", "UT", "WY"];
const PACIFIC = ["CA", "NV", "OR", "WA"];
const ZONE_BY_STATE: Record<string, string> = {
  ...Object.fromEntries(EASTERN.map((s) => [s, "America/New_York"])),
  ...Object.fromEntries(MOUNTAIN.map((s) => [s, "America/Denver"])),
  ...Object.fromEntries(PACIFIC.map((s) => [s, "America/Los_Angeles"])),
  AZ: "America/Phoenix",
  AK: "America/Anchorage",
  HI: "Pacific/Honolulu",
  PR: "America/Puerto_Rico",
};
/** Area codes in a different zone from the rest of their state. */
const ZONE_BY_CODE: Record<number, string> = {
  219: "America/Chicago", // northwest Indiana
  850: "America/Chicago", // Florida panhandle, west of Tallahassee
  270: "America/Chicago", // western Kentucky
  364: "America/Chicago",
  423: "America/New_York", // east Tennessee
  865: "America/New_York",
  915: "America/Denver", // El Paso
};

const STATE_BY_CODE = new Map<number, string>(Object.entries(STATES).flatMap(([state, codes]) => codes.map((c) => [c, state] as const)));

const areaCode = (e164: string | null | undefined) => {
  const m = e164?.match(/^\+1(\d{3})\d{7}$/);
  return m ? Number(m[1]) : null;
};

export function phoneState(e164: string | null | undefined): string | null {
  const code = areaCode(e164);
  return code ? (STATE_BY_CODE.get(code) ?? null) : null;
}

/** The recipient's zone by area code, or null when the area code isn't a known US one. */
export function phoneTimeZone(e164: string | null | undefined): string | null {
  const code = areaCode(e164);
  if (!code) return null;
  const state = STATE_BY_CODE.get(code);
  if (!state) return null;
  return ZONE_BY_CODE[code] ?? ZONE_BY_STATE[state] ?? "America/Chicago";
}
