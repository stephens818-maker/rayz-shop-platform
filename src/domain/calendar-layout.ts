/** Narrowest a barber column gets before the day board pages barbers instead of scrolling sideways. */
export const MIN_COLUMN_PX = 120;
/** The time gutter on the left of the board. */
export const GUTTER_PX = 56;

/** How many barber columns fit across a board this wide (at least one). */
export const columnsThatFit = (width: number) => Math.max(1, Math.floor((width - GUTTER_PX) / MIN_COLUMN_PX));
