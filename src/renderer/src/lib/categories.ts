/** Category-picker helpers — port of the web's lib/categories.ts pure halves. */

export const BUILT_IN_CATEGORIES = ['password', 'link'] as const;

/** Remove exact duplicates and names colliding with a built-in pill key (React-key safety). */
export function dedupeCategoryNames(names: string[]): string[] {
  const builtIn = new Set<string>(BUILT_IN_CATEGORIES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    if (builtIn.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
