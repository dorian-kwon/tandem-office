/** A picture the engine laid out: its page and the hash of its bytes (see `hwpPicturePlaces`). */
export interface LaidOutPicture {
  page: number
  sha256: string
}

/**
 * Put the stored pictures of a Hangul document in reading order. The pictures the layout knows
 * come first, in the order the pages show them, each with its page. The others (a header's
 * picture, a background, a fill) have no place on a page, so they follow in the order they were
 * stored, with no page. Two stored pictures with the same bytes are one place on the pages: the
 * first one stored takes it.
 *
 * `hashes[i]` is the SHA-256 of `images[i]`.
 */
export function orderByPlaces<T>(
  images: readonly T[],
  hashes: readonly string[],
  places: readonly LaidOutPicture[],
): { image: T; page: number | undefined }[] {
  const rankOf = new Map<string, number>()
  places.forEach((place, rank) => {
    if (!rankOf.has(place.sha256)) rankOf.set(place.sha256, rank)
  })
  const taken = new Set<string>()
  const placed: { image: T; rank: number; page: number }[] = []
  const rest: { image: T; page: undefined }[] = []
  images.forEach((image, i) => {
    const hash = hashes[i]!
    const rank = rankOf.get(hash)
    if (rank === undefined || taken.has(hash)) {
      rest.push({ image, page: undefined })
      return
    }
    taken.add(hash)
    placed.push({ image, rank, page: places[rank]!.page })
  })
  placed.sort((a, b) => a.rank - b.rank)
  return [...placed.map(({ image, page }) => ({ image, page })), ...rest]
}
