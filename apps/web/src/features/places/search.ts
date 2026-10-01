export type PlaceScope = "all" | "favorites" | "recent";
type Searchable = {
  id: string;
  name: string;
  aliases: string[];
  category: string;
};

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("zh-CN")
    .trim()
    .replace(/\s+/g, " ");
}

export function findPlaces<T extends Searchable>(
  points: readonly T[],
  query: string,
  category: string,
  orderedIds?: readonly string[],
): T[] {
  const byId = new Map(points.map((point) => [point.id, point]));
  // Resolve saved IDs against today's public catalog: no stale names or content.
  const candidates = orderedIds
    ? [...new Set(orderedIds)].flatMap((id) =>
        byId.has(id) ? [byId.get(id)!] : [],
      )
    : [...points];
  const q = normalize(query);
  const tokens = q.split(" ").filter(Boolean);
  return candidates
    .flatMap((point, order) => {
      if (category !== "all" && point.category !== category) return [];
      const name = normalize(point.name);
      const aliases = point.aliases.map(normalize);
      const fields = [name, ...aliases];
      if (
        !tokens.every((token) => fields.some((field) => field.includes(token)))
      )
        return [];
      const rank = !q
        ? 0
        : name === q
          ? 0
          : aliases.includes(q)
            ? 1
            : name.startsWith(q)
              ? 2
              : aliases.some((alias) => alias.startsWith(q))
                ? 3
                : 4;
      return [{ point, rank, order }];
    })
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map(({ point }) => point);
}
