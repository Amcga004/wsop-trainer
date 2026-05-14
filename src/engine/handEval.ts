import type { Card } from '../types'

const RANK_VAL: Record<string, number> = {
  'A':14,'K':13,'Q':12,'J':11,'T':10,
  '9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2,
}

export interface HandResult {
  str:      number   // 0=air 1=pair 2=twopair 3=set 4=straight 5=flush 6=boat 7=quads
  label:    string
  pairPos:  string   // 'toppair'|'overpair'|'secondpair'|'bottompair'|'underpair'|'set'|'twopair'|'straight'|'flush'|'boat'|'quads'|'none'
  pairVal:  number
  heroFD:   boolean  // hero has flush draw
  heroNFD:  boolean  // hero has nut flush draw
  oesd:     boolean  // hero contributes to open-ended straight draw
  gut:      boolean  // hero contributes to gutshot
  overcards: number  // 0, 1, or 2 overcards to the board
}

export function evalHand(
  h1: Card,
  h2: Card,
  board: Card[]
): HandResult {
  if (!board || board.length === 0) {
    return { str:0, label:'No board', pairPos:'none', pairVal:0, heroFD:false, heroNFD:false, oesd:false, gut:false, overcards:0 }
  }

  const all = [h1, h2, ...board]
  const bSorted = [...board].map(c => RANK_VAL[c.r]).sort((a,b) => b-a)

  // Flush detection
  const suitCount: Record<string, number> = {}
  all.forEach(c => suitCount[c.s] = (suitCount[c.s]||0) + 1)
  const heroFlush = [h1.s, h2.s].some(s => suitCount[s] >= 5)

  // Flush draw detection — hero must contribute
  const heroFD  = !heroFlush && [h1.s, h2.s].some(s => suitCount[s] === 4 && [h1,h2].some(c => c.s === s))
  const heroNFD = heroFD && (
    (h1.s === h2.s && RANK_VAL[h1.r] === 14) ||
    (suitCount[h1.s] === 4 && RANK_VAL[h1.r] === 14) ||
    (suitCount[h2.s] === 4 && RANK_VAL[h2.r] === 14)
  )

  // Rank counts
  const rankCount: Record<string, number> = {}
  all.forEach(c => rankCount[c.r] = (rankCount[c.r]||0) + 1)

  const heroMadeRanks = Object.entries(rankCount)
    .filter(([r, cnt]) => cnt >= 2 && (r === h1.r || r === h2.r))
  const quads  = heroMadeRanks.filter(([,c]) => c >= 4)
  const trips  = heroMadeRanks.filter(([,c]) => c >= 3)

  // Straight detection
  const allVals = [...new Set(all.map(c => RANK_VAL[c.r]))].sort((a,b) => a-b)
  if (allVals.includes(14)) allVals.unshift(1) // ace-low
  let straight = false
  for (let i = 0; i <= allVals.length - 5; i++) {
    const seg = allVals.slice(i, i+5)
    if (seg[4] - seg[0] === 4 && new Set(seg).size === 5) { straight = true; break }
  }

  // Straight draw detection — hero must contribute at least 1 card to a 4-card run
  const hVals = [RANK_VAL[h1.r], RANK_VAL[h2.r]]
  const combined = [...new Set([...hVals, ...bSorted])].sort((a,b) => a-b)
  let oesd = false, gut = false
  for (let i = 0; i <= combined.length - 4; i++) {
    const seg = combined.slice(i, i+4)
    if (new Set(seg).size !== 4) continue
    const heroInSeg = hVals.some(v => seg.includes(v))
    if (!heroInSeg) continue
    const span = seg[3] - seg[0]
    if (span === 3) oesd = true
    if (span === 4) gut  = true
  }

  // Results — quads
  if (quads.length) return { str:7, label:'Four of a kind', pairPos:'quads', pairVal:RANK_VAL[quads[0][0]], heroFD, heroNFD, oesd, gut, overcards:0 }

  // Full house
  if (trips.length && Object.values(rankCount).some(c => c >= 2 && trips.every(([r]) => rankCount[r] !== c))) {
    return { str:6, label:'Full house', pairPos:'boat', pairVal:RANK_VAL[trips[0][0]], heroFD, heroNFD, oesd, gut, overcards:0 }
  }
  // Simpler full house check
  const allPairs = Object.entries(rankCount).filter(([,c]) => c >= 2)
  if (trips.length && allPairs.length >= 2) {
    return { str:6, label:'Full house', pairPos:'boat', pairVal:RANK_VAL[trips[0][0]], heroFD, heroNFD, oesd, gut, overcards:0 }
  }

  if (heroFlush)    return { str:5, label:'Flush',        pairPos:'flush',    pairVal:0, heroFD:false, heroNFD:false, oesd, gut, overcards:0 }
  if (straight)     return { str:4, label:'Straight',     pairPos:'straight', pairVal:0, heroFD, heroNFD, oesd, gut, overcards:0 }
  if (trips.length) return { str:3, label:'Set / Trips',  pairPos:'set',      pairVal:RANK_VAL[trips[0][0]], heroFD, heroNFD, oesd, gut, overcards:0 }

  // Two pair
  if (heroMadeRanks.length >= 2) {
    const bestPairVal = Math.max(...heroMadeRanks.map(([r]) => RANK_VAL[r]))
    return { str:2, label:'Two pair', pairPos:'twopair', pairVal:bestPairVal, heroFD, heroNFD, oesd, gut, overcards:0 }
  }

  // One pair
  if (heroMadeRanks.length === 1) {
    const pv  = RANK_VAL[heroMadeRanks[0][0]]
    const isPocket = h1.r === h2.r
    let pairPos = 'bottompair'
    if (isPocket) {
      pairPos = pv > bSorted[0] ? 'overpair' : pv === bSorted[0] ? 'toppair' : pv < bSorted[bSorted.length-1] ? 'underpair' : 'midpair'
    } else {
      if      (pv === bSorted[0])                           pairPos = 'toppair'
      else if (bSorted.length >= 2 && pv === bSorted[1])   pairPos = 'secondpair'
      else                                                  pairPos = 'bottompair'
    }
    const label = pairPos === 'toppair' ? 'Top pair' : pairPos === 'overpair' ? 'Overpair' : pairPos === 'secondpair' ? 'Second pair' : 'Bottom pair'
    return { str:1, label, pairPos, pairVal:pv, heroFD, heroNFD, oesd, gut, overcards:0 }
  }

  // Air — overcards
  const overcards = hVals.filter(v => v > bSorted[0]).length
  return { str:0, label: overcards >= 2 ? 'Two overcards' : overcards === 1 ? 'One overcard' : 'High card', pairPos:'none', pairVal:0, heroFD, heroNFD, oesd, gut, overcards }
}

export interface HandComparison {
  heroWins: boolean
  tie: boolean
}

export function compareHands(
  h1c1: Card, h1c2: Card,
  h2c1: Card, h2c2: Card,
  board: Card[]
): HandComparison {
  const h1 = evalHand(h1c1, h1c2, board)
  const h2 = evalHand(h2c1, h2c2, board)

  if (h1.str > h2.str) return { heroWins: true,  tie: false }
  if (h2.str > h1.str) return { heroWins: false, tie: false }

  const str = h1.str

  const ranks = (cards: Card[]) =>
    cards.map(c => RANK_VAL[c.r]).sort((a, b) => b - a)

  const kickers = (cards: Card[], excludeRanks: number[], count: number) => {
    const available = cards
      .map(c => RANK_VAL[c.r])
      .filter(r => {
        const idx = excludeRanks.indexOf(r)
        if (idx !== -1) { excludeRanks.splice(idx, 1); return false }
        return true
      })
      .sort((a, b) => b - a)
    return available.slice(0, count)
  }

  const all1 = [h1c1, h1c2, ...board]
  const all2 = [h2c1, h2c2, ...board]

  const cmpArr = (a: number[], b: number[]): number => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const av = a[i] ?? 0, bv = b[i] ?? 0
      if (av > bv) return  1
      if (bv > av) return -1
    }
    return 0
  }

  let cmp = 0

  if (str === 0) {
    cmp = cmpArr(ranks(all1).slice(0, 5), ranks(all2).slice(0, 5))
  }

  else if (str === 1) {
    const pv1 = h1.pairVal, pv2 = h2.pairVal
    if (pv1 !== pv2) cmp = pv1 > pv2 ? 1 : -1
    else {
      const k1 = kickers(all1, [pv1, pv1], 3)
      const k2 = kickers(all2, [pv2, pv2], 3)
      cmp = cmpArr(k1, k2)
    }
  }

  else if (str === 2) {
    const findPairs = (cards: Card[]) => {
      const rv = cards.map(c => RANK_VAL[c.r])
      const counts: Record<number, number> = {}
      rv.forEach(r => { counts[r] = (counts[r] || 0) + 1 })
      return Object.entries(counts)
        .filter(([, c]) => c >= 2)
        .map(([r]) => Number(r))
        .sort((a, b) => b - a)
    }
    const pairs1 = findPairs(all1)
    const pairs2 = findPairs(all2)
    cmp = cmpArr(pairs1.slice(0, 2), pairs2.slice(0, 2))
    if (cmp === 0) {
      const excl1 = [...pairs1.slice(0, 2), ...pairs1.slice(0, 2)]
      const excl2 = [...pairs2.slice(0, 2), ...pairs2.slice(0, 2)]
      cmp = cmpArr(kickers(all1, excl1, 1), kickers(all2, excl2, 1))
    }
  }

  else if (str === 3) {
    const pv1 = h1.pairVal, pv2 = h2.pairVal
    if (pv1 !== pv2) cmp = pv1 > pv2 ? 1 : -1
    else {
      const k1 = kickers(all1, [pv1, pv1, pv1], 2)
      const k2 = kickers(all2, [pv2, pv2, pv2], 2)
      cmp = cmpArr(k1, k2)
    }
  }

  else if (str === 4) {
    const straightHigh = (cards: Card[]) => {
      const rv = [...new Set(cards.map(c => RANK_VAL[c.r]))].sort((a, b) => b - a)
      if (rv.includes(14)) rv.push(1)
      for (let hi = rv[0]; hi >= 5; hi--) {
        if ([hi, hi-1, hi-2, hi-3, hi-4].every(r => rv.includes(r))) return hi
      }
      return 0
    }
    const s1 = straightHigh(all1), s2 = straightHigh(all2)
    cmp = s1 > s2 ? 1 : s1 < s2 ? -1 : 0
  }

  else if (str === 5) {
    const flushRanks = (cards: Card[]) => {
      const suitCounts: Record<string, number[]> = {}
      cards.forEach(c => {
        if (!suitCounts[c.s]) suitCounts[c.s] = []
        suitCounts[c.s].push(RANK_VAL[c.r])
      })
      for (const rs of Object.values(suitCounts)) {
        if (rs.length >= 5) return rs.sort((a, b) => b - a).slice(0, 5)
      }
      return []
    }
    cmp = cmpArr(flushRanks(all1), flushRanks(all2))
  }

  else if (str === 6) {
    const fullHouseRanks = (cards: Card[], pairVal: number) => {
      const rv = cards.map(c => RANK_VAL[c.r])
      const counts: Record<number, number> = {}
      rv.forEach(r => { counts[r] = (counts[r] || 0) + 1 })
      const trips = Object.entries(counts)
        .filter(([, c]) => c >= 3).map(([r]) => Number(r))
        .sort((a, b) => b - a)[0] ?? pairVal
      const pair = Object.entries(counts)
        .filter(([r, c]) => c >= 2 && Number(r) !== trips)
        .map(([r]) => Number(r)).sort((a, b) => b - a)[0] ?? 0
      return [trips, pair]
    }
    cmp = cmpArr(fullHouseRanks(all1, h1.pairVal), fullHouseRanks(all2, h2.pairVal))
  }

  else if (str === 7) {
    const pv1 = h1.pairVal, pv2 = h2.pairVal
    if (pv1 !== pv2) cmp = pv1 > pv2 ? 1 : -1
    else {
      const k1 = kickers(all1, [pv1, pv1, pv1, pv1], 1)
      const k2 = kickers(all2, [pv2, pv2, pv2, pv2], 1)
      cmp = cmpArr(k1, k2)
    }
  }

  if (cmp > 0) return { heroWins: true,  tie: false }
  if (cmp < 0) return { heroWins: false, tie: false }
  return { heroWins: false, tie: true }
}

// Board texture helpers used by scenarios and coaching
export function boardHasAce(board: Card[]):   boolean { return board.some(c => c.r === 'A') }
export function boardHasKing(board: Card[]):  boolean { return board.some(c => c.r === 'K') }
export function isPairedBoard(board: Card[]): boolean {
  const ranks = board.map(c => c.r)
  return new Set(ranks).size < ranks.length
}
export function isMonotoneBoard(board: Card[]): boolean {
  return new Set(board.map(c => c.s)).size === 1
}
export function isTwoToneBoard(board: Card[]): boolean {
  return new Set(board.map(c => c.s)).size === 2
}
