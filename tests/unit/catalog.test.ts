import { describe, expect, it } from 'vitest'

import {
  buildCatalog,
  productUnderVendors,
  searchProducts,
  searchVendors,
  vendorIdsNamed,
  type Catalog,
} from '../../lib/catalog'

/**
 * The in-memory catalog behind the canvas pickers (UI polish, 2026-08-16).
 * Small on purpose: what is under test is the ranking and the grouping, not
 * the scan.
 */
const WIRE: Catalog = {
  vendors: [
    [1, 'Cisco'],
    [2, 'Francisco Systems'],
    [3, 'Microsoft'],
    [4, 'Linux'],
    [5, 'linux'], // the same name twice, differently cased — the corpus does this
    [6, "O'Reilly'); DROP TABLE cve; --"],
  ],
  products: [
    [10, 1, 'IOS XE', 500],
    [11, 1, 'IOS', 900],
    [12, 2, 'Router', 3],
    [13, 3, 'Windows', 4000],
    [14, 4, 'Linux Kernel', 2500],
    [15, 5, 'linux kernel', 100],
    [16, 3, 'IOS', 1], // a Microsoft product that happens to share Cisco's name
  ],
}

const index = buildCatalog(WIRE)

describe('buildCatalog', () => {
  it('sums a vendor’s rank from its products and keys names lowercased', () => {
    expect(index.vendorById.get(1)?.count).toBe(1400)
    expect(index.vendorById.get(3)?.count).toBe(4001)
    expect(index.vendorById.get(6)?.key).toBe("o'reilly'); drop table cve; --")
  })
})

describe('searchVendors', () => {
  it('matches case-insensitively by substring, ranking prefix over infix and exact over prefix', () => {
    const names = searchVendors(index, 'CIS', 10).map((v) => v.name)
    // Cisco is a prefix match; Francisco is an infix one.
    expect(names).toEqual(['Cisco', 'Francisco Systems'])
    // Exact beats prefix, whatever the rank: "linux" is exact for both spellings
    // of that vendor, and Microsoft (which does not match) is absent.
    expect(searchVendors(index, 'linux', 10).map((v) => v.name)).toEqual(['Linux', 'linux'])
  })

  it('lists the most-listed vendors first when nothing is typed, and honours the cap', () => {
    const names = searchVendors(index, '', 2).map((v) => v.name)
    expect(names).toEqual(['Microsoft', 'Linux'])
  })

  it('finds a hostile name like any other, as text', () => {
    expect(searchVendors(index, 'drop table', 5).map((v) => v.id)).toEqual([6])
  })
})

describe('searchProducts', () => {
  it('groups one name across vendors when no vendor is chosen, naming the vendors', () => {
    const ios = searchProducts(index, 'ios', null, 10)
    // "IOS" (exact, 901 rows across Cisco and Microsoft) then "IOS XE" (prefix).
    expect(ios.map((p) => p.name)).toEqual(['IOS', 'IOS XE'])
    expect(ios[0]!.count).toBe(901)
    expect(ios[0]!.vendors).toEqual(['Cisco', 'Microsoft'])
  })

  it('narrows to the chosen vendors, and then names no vendor', () => {
    const cisco = vendorIdsNamed(index, ['cisco'])
    expect([...cisco]).toEqual([1])
    const ios = searchProducts(index, 'ios', cisco, 10)
    expect(ios.map((p) => p.name)).toEqual(['IOS', 'IOS XE'])
    expect(ios[0]!.count).toBe(900)
    expect(ios[0]!.vendors).toEqual(['Cisco'])
    expect(searchProducts(index, 'windows', cisco, 10)).toEqual([])
  })

  it('folds differently-cased duplicates into one name, like the filter will', () => {
    const kernels = searchProducts(index, 'kernel', null, 10)
    expect(kernels).toHaveLength(1)
    expect(kernels[0]!.count).toBe(2600)
    expect(kernels[0]!.vendors).toEqual(['Linux', 'linux'])
  })
})

describe('vendorIdsNamed / productUnderVendors', () => {
  it('resolves names the way LOOKUP_SQL does — trimmed, case-insensitive, all matches', () => {
    expect([...vendorIdsNamed(index, ['  LINUX '])].sort()).toEqual([4, 5])
    expect(vendorIdsNamed(index, ['nobody']).size).toBe(0)
  })

  it('says whether a product filter survives a vendor change', () => {
    expect(productUnderVendors(index, ['Windows'], vendorIdsNamed(index, ['Microsoft']))).toBe(true)
    expect(productUnderVendors(index, ['Windows'], vendorIdsNamed(index, ['Cisco']))).toBe(false)
    expect(productUnderVendors(index, ['ios'], vendorIdsNamed(index, ['Cisco']))).toBe(true)
  })
})
