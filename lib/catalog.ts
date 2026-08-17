/**
 * The vendor / product catalog behind the canvas pickers (UI polish,
 * 2026-08-16).
 *
 * The two selectors above the chart have to answer a keystroke without a
 * round trip: the hosted tier is a synchronous XHR inside the Worker, and even
 * locally a query per keypress would race the report it re-runs. So the whole
 * name space — 24,436 vendors and 80,213 products, roughly two megabytes of
 * strings — is read once per copy (`catalog` Worker message) and searched here,
 * in memory, by case-insensitive substring. A linear scan over 80,000
 * lowercased names is a few milliseconds, which is why there is no cleverer
 * index than that.
 *
 * Every name here is record text (rule 4): it is rendered as a text node by
 * the picker and reaches SQL only as a bound value through the same
 * `filters.vendor` / `filters.product` name lists a permalink carries.
 */

/** The wire shape: arrays, not objects, because 80,000 of them are cloned. */
export interface Catalog {
  /** `[id, name]` */
  vendors: [number, string][]
  /** `[id, vendorId, name, records]` — `records` is how many CVEs list it. */
  products: [number, number, string, number][]
}

export interface VendorEntry {
  id: number
  name: string
  /** CVE-product rows under this vendor: a popularity rank, not a CVE count. */
  count: number
  /** `name.toLowerCase()`, once. */
  key: string
}

export interface ProductEntry {
  id: number
  vendorId: number
  name: string
  count: number
  key: string
}

/**
 * One product *name* as the picker offers it. Names are what a filter carries
 * (`filters.product` is a list of names, matched case-insensitively across
 * every vendor), so with no vendor chosen the same name under several vendors
 * is one row — with the vendors named beside it — and choosing it selects all
 * of them, which is exactly what the filter would then match.
 */
export interface ProductMatch {
  name: string
  count: number
  /** The vendors that carry a product of this name, most-listed first. */
  vendors: string[]
}

export interface CatalogIndex {
  vendors: VendorEntry[]
  products: ProductEntry[]
  vendorById: Map<number, VendorEntry>
}

export function buildCatalog(catalog: Catalog): CatalogIndex {
  const vendorById = new Map<number, VendorEntry>()
  const vendors: VendorEntry[] = []
  for (const [id, name] of catalog.vendors) {
    const entry: VendorEntry = { id, name, count: 0, key: name.toLowerCase() }
    vendors.push(entry)
    vendorById.set(id, entry)
  }
  const products: ProductEntry[] = []
  for (const [id, vendorId, name, count] of catalog.products) {
    products.push({ id, vendorId, name, count, key: name.toLowerCase() })
    const vendor = vendorById.get(vendorId)
    if (vendor) vendor.count += count
  }
  return { vendors, products, vendorById }
}

/**
 * How well a name matches what was typed: 0 is no match, then substring,
 * prefix, exact — so "cis" ranks Cisco above "Francisco Systems", and
 * "linux" ranks the vendor called exactly that first.
 */
function tier(key: string, query: string): number {
  if (query === '') return 1
  const at = key.indexOf(query)
  if (at < 0) return 0
  if (at > 0) return 1
  return key.length === query.length ? 3 : 2
}

/**
 * Vendors matching `query`, best first: match tier, then how many CVE-product
 * rows the vendor has, then name. An empty query lists the most-listed vendors,
 * which is what an opened picker with nothing typed should offer.
 */
export function searchVendors(index: CatalogIndex, query: string, limit: number): VendorEntry[] {
  const q = query.trim().toLowerCase()
  const scored: { entry: VendorEntry; tier: number }[] = []
  for (const entry of index.vendors) {
    const t = tier(entry.key, q)
    if (t > 0) scored.push({ entry, tier: t })
  }
  scored.sort(
    (a, b) =>
      b.tier - a.tier || b.entry.count - a.entry.count || a.entry.key.localeCompare(b.entry.key)
  )
  return scored.slice(0, limit).map((s) => s.entry)
}

/**
 * Product names matching `query`, narrowed to `vendorIds` when a vendor is
 * chosen, best first — grouped by name (see `ProductMatch`).
 */
export function searchProducts(
  index: CatalogIndex,
  query: string,
  vendorIds: ReadonlySet<number> | null,
  limit: number
): ProductMatch[] {
  const q = query.trim().toLowerCase()
  const groups = new Map<
    string,
    { name: string; count: number; tier: number; vendors: Map<VendorEntry, number> }
  >()
  for (const entry of index.products) {
    if (vendorIds && !vendorIds.has(entry.vendorId)) continue
    const t = tier(entry.key, q)
    if (t === 0) continue
    let group = groups.get(entry.key)
    if (!group) {
      group = { name: entry.name, count: 0, tier: t, vendors: new Map() }
      groups.set(entry.key, group)
    }
    group.count += entry.count
    const vendor = index.vendorById.get(entry.vendorId)
    if (vendor) group.vendors.set(vendor, (group.vendors.get(vendor) ?? 0) + entry.count)
  }
  const ranked = [...groups.values()].sort(
    (a, b) => b.tier - a.tier || b.count - a.count || a.name.localeCompare(b.name)
  )
  return ranked.slice(0, limit).map((group) => ({
    name: group.name,
    count: group.count,
    // The vendors that list this name, the one listing it most first — the
    // product's own rank under each vendor, not the vendor's overall size.
    vendors: [...group.vendors.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].key.localeCompare(b[0].key))
      .map(([vendor]) => vendor.name),
  }))
}

/**
 * The vendor ids a filter's vendor names resolve to — the same case-insensitive
 * match `LOOKUP_SQL` performs (lib/filters.ts), so the product picker narrows
 * to exactly the vendors the report will count.
 */
export function vendorIdsNamed(index: CatalogIndex, names: readonly string[]): Set<number> {
  const wanted = new Set(names.map((name) => name.trim().toLowerCase()))
  const ids = new Set<number>()
  for (const vendor of index.vendors) if (wanted.has(vendor.key)) ids.add(vendor.id)
  return ids
}

/**
 * Whether a product filter still makes sense under a vendor filter — used
 * when the vendor changes, so a picker never shows "Cisco · Windows".
 */
export function productUnderVendors(
  index: CatalogIndex,
  productNames: readonly string[],
  vendorIds: ReadonlySet<number>
): boolean {
  const wanted = new Set(productNames.map((name) => name.trim().toLowerCase()))
  for (const product of index.products) {
    if (vendorIds.has(product.vendorId) && wanted.has(product.key)) return true
  }
  return false
}
