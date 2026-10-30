/** Regions: optional groupings of locations (markets) for the brand's location comparison. */

export function regionNameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length < 2) return "Give the region a name";
  if (n.length > 60) return "Keep the region name to 60 characters or fewer";
  return null;
}
