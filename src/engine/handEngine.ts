// src/engine/handEngine.ts
// ─────────────────────────────────────────────────────────────
// WSOP Tournament Trainer — Real Hand Engine
// Simulates a complete poker hand from deal to showdown
// with real deck management, villain range-based hand assignment,
// and archetype-driven postflop decisions
// ─────────────────────────────────────────────────────────────

import type { Card, Quality } from '../types'
import {
  getBB, getSB, getAnte, getBBDepth, getOpenSize,
  STARTING_STACK, ITM_PLAYERS, isNearBubble,
} from './tournamentStructure'
import {
  DEEP_RANGES, MID_RANGES, SHOVE_RANGES,
  getRanges, getShoveRanges, BOARD_TEXTURE,
  type Position, type ShoveTier,
} from './rangeData'
import { evalHand, compareHands, type HandResult } from './handEval'
import {
  ARCHETYPES, villainDecision, type Archetype,
} from './villainAI'
import { initHand, heroActs, villainResponds, resolveHand } from './chipMath'

function raiseLabel(raisersBeforeThisRaise: number): string {
  const labels = ['raises', '3-bets', '4-bets', '5-bets', '6-bets']
  return labels[Math.min(raisersBeforeThisRaise, labels.length - 1)]
}

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type Street = 'preflop' | 'flop' | 'turn' | 'river'

export type PlayerAction =
  | { type: 'fold' }
  | { type: 'check' }
  | { type: 'limp';  amount: number }
  | { type: 'call';  amount: number }
  | { type: 'raise'; amount: number }
  | { type: 'shove'; amount: number }

export interface Seat {
  seatIndex:  number        // 0-8
  position:   Position
  name:       string
  stack:      number
  archetype:  Archetype
  holeCards:  [Card, Card] | null
  folded:     boolean
  allIn:      boolean
  invested:   number        // total chips put in this hand
}

export interface HeroDecision {
  street:       Street
  board:        Card[]
  pot:          number
  heroStack:    number
  heroPos:      Position
  heroCards:    [Card, Card]
  desc:         string          // narrative description of action so far
  options:      HeroOption[]
  activePlayers: number         // how many players still in
  lastAggressor: Seat | null    // who hero is responding to
}

export interface HeroOption {
  label:      string
  type:       PlayerAction['type']
  amount:     number            // 0 for check/fold
  quality:    Quality
  coaching:   string
  chipCost:   number            // net chips hero pays
}

export interface StreetResult {
  street:     Street
  board:      Card[]
  heroAction: HeroOption
  pot:        number
  desc:       string
}

export interface HandSummary {
  streets:        StreetResult[]
  heroNetChips:   number
  heroFinalStack: number
  wentToShowdown: boolean
  showdownSeat:   Seat | null   // villain hero is guessing against
  heroWon:        boolean
}

export interface VillainProfile {
  seatIndex:      number
  position:       string
  actionSequence: string[]   // preflop code, then one entry per street
  rangeStrength:  number     // 1-10 (0 = unknown/folded)
  rangeNarrow:    string     // human-readable description
  isPrimary:      boolean
}

// ─────────────────────────────────────────────────────────────
// DECK
// ─────────────────────────────────────────────────────────────

const RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2']
const SUITS = ['♠','♥','♦','♣']

export function buildDeck(): Card[] {
  const deck: Card[] = []
  for (const r of RANKS) for (const s of SUITS) deck.push({ r, s })
  return deck
}

export function shuffleDeck(deck: Card[]): Card[] {
  const d = [...deck]
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[d[i], d[j]] = [d[j], d[i]]
  }
  return d
}

function dealCard(deck: Card[]): Card {
  const card = deck.pop()
  if (!card) throw new Error('Deck exhausted')
  return card
}

function burnAndDeal(deck: Card[], count: number): Card[] {
  dealCard(deck) // burn
  const cards: Card[] = []
  for (let i = 0; i < count; i++) cards.push(dealCard(deck))
  return cards
}

// ─────────────────────────────────────────────────────────────
// POSITION SYSTEM
// ─────────────────────────────────────────────────────────────

const ALL_POSITIONS: Position[] = [
  'BTN', 'SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO'
]

// Preflop action order (UTG first, BTN last preflop, BB last)
const PREFLOP_ORDER: Position[] = [
  'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'
]

// Postflop action order (SB first, BTN last)
const POSTFLOP_ORDER: Position[] = [
  'SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN'
]

const VILLAIN_NAMES = [
  'A. Chen', 'R. Polk', 'J. Martinez', 'D. Kim',
  'S. Patel', 'B. Miller', 'T. Jones', 'C. Davis', 'L. Wilson'
]

// ─────────────────────────────────────────────────────────────
// HAND-TO-STRING CONVERSION
// ─────────────────────────────────────────────────────────────

function cardToHandStr(c1: Card, c2: Card): string {
  const rankOrder = ['A','K','Q','J','T','9','8','7','6','5','4','3','2']
  if (c1.r === c2.r) return c1.r + c2.r
  const i1 = rankOrder.indexOf(c1.r)
  const i2 = rankOrder.indexOf(c2.r)
  const [hi, lo] = i1 < i2 ? [c1, c2] : [c2, c1]
  const suited = c1.s === c2.s ? 's' : 'o'
  return hi.r + lo.r + suited
}

// ─────────────────────────────────────────────────────────────
// RANGE-BASED HAND DEALING
// Deal a villain a hand consistent with their action
// ─────────────────────────────────────────────────────────────

function dealHandFromRange(
  range: string[],
  deck: Card[],
  usedCards: Set<string>
): [Card, Card] | null {
  // Try up to 50 times to find a hand in range from available deck
  const available = deck.filter(c => !usedCards.has(c.r + c.s))

  // Build all possible 2-card combos from available cards
  const combos: [Card, Card][] = []
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const h = cardToHandStr(available[i], available[j])
      if (range.includes(h)) {
        combos.push([available[i], available[j]])
      }
    }
  }

  if (combos.length === 0) return null

  // Pick a random combo from valid options
  const [c1, c2] = combos[Math.floor(Math.random() * combos.length)]

  // Remove from deck
  const idx1 = deck.findIndex(c => c.r === c1.r && c.s === c1.s)
  const idx2 = deck.findIndex(c => c.r === c2.r && c.s === c2.s)
  if (idx1 > idx2) { deck.splice(idx1, 1); deck.splice(idx2, 1) }
  else { deck.splice(idx2, 1); deck.splice(idx1, 1) }

  usedCards.add(c1.r + c1.s)
  usedCards.add(c2.r + c2.s)

  return [c1, c2]
}

function dealRandomHand(
  deck: Card[],
  usedCards: Set<string>
): [Card, Card] {
  const c1 = deck.pop()!
  const c2 = deck.pop()!
  usedCards.add(c1.r + c1.s)
  usedCards.add(c2.r + c2.s)
  return [c1, c2]
}

// ─────────────────────────────────────────────────────────────
// VILLAIN BET SIZING (randomized within archetype ranges)
// ─────────────────────────────────────────────────────────────

function villainBetSize(
  archetype: Archetype,
  pot: number,
  stack: number,
  street: Street,
  handStrength: number
): number {
  const ranges: Record<Archetype, [number, number]> = {
    LP: [0.40, 0.60],
    TA: [0.55, 0.75],
    LA: [0.65, 1.20],
    TP: [0.45, 0.55],
  }
  const [min, max] = ranges[archetype]
  const pct = min + Math.random() * (max - min)
  // Value hands size up, bluffs size down
  const adjustment = handStrength >= 3 ? 1.15 : handStrength === 0 ? 0.85 : 1.0
  const amount = Math.round(pot * pct * adjustment / 100) * 100
  // already rounds to 100 — ensure minimum 100
  return Math.max(100, Math.min(amount, stack))
}

function villainRaiseSize(
  archetype: Archetype,
  betToCall: number,
  pot: number,
  stack: number
): number {
  const multipliers: Record<Archetype, [number, number]> = {
    LP: [2.2, 2.8],
    TA: [2.5, 3.2],
    LA: [2.8, 4.0],
    TP: [2.5, 3.0],
  }
  const [min, max] = multipliers[archetype]
  const mult = min + Math.random() * (max - min)
  const amount = Math.round(betToCall * mult / 100) * 100
  return Math.min(amount, stack)
}

// ─────────────────────────────────────────────────────────────
// VILLAIN POSTFLOP DECISION
// Returns action based on archetype, hand strength, and situation
// ─────────────────────────────────────────────────────────────

function resolveVillainPostflop(
  seat: Seat,
  board: Card[],
  pot: number,
  betFacing: number,  // 0 if checking, >0 if facing a bet
  street: Street,
  levelIndex: number,
  isAggressor: boolean // did this villain bet last street
): { action: PlayerAction; desc: string } {
  if (!seat.holeCards) return { action: { type: 'fold' }, desc: `${seat.position} folds` }

  const hs = evalHand(seat.holeCards[0], seat.holeCards[1], board)
  const A = ARCHETYPES[seat.archetype]
  const depth = getBBDepth(seat.stack, levelIndex)
  const stackCommitted = seat.invested / (seat.stack + seat.invested)

  // Board texture (FIX 4)
  const suitCounts: Record<string, number> = {}
  for (const c of board) suitCounts[c.s] = (suitCounts[c.s] ?? 0) + 1
  const maxSuitCount = Object.values(suitCounts).length > 0 ? Math.max(...Object.values(suitCounts)) : 0
  const RANK_VAL_V: Record<string, number> = {'A':14,'K':13,'Q':12,'J':11,'T':10,'9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2}
  const boardVals = board.map(c => RANK_VAL_V[c.r]).sort((a,b) => b-a)
  const rankRange = boardVals.length >= 2 ? boardVals[0] - boardVals[boardVals.length-1] : 0
  const isWet = maxSuitCount >= 2 || rankRange <= 4
  const textureFoldAdj = isWet ? 0.08 : -0.05

  // Facing a bet
  if (betFacing > 0) {
    const potOdds = betFacing / (pot + betFacing)

    // Strong hands: call or raise
    if (hs.str >= 4) {
      if (Math.random() < A.raiseNuts && seat.stack > betFacing * 2.5) {
        const raiseAmt = villainRaiseSize(seat.archetype, betFacing, pot, seat.stack)
        return {
          action: { type: 'raise', amount: raiseAmt },
          desc: `${seat.position} raises to ${raiseAmt.toLocaleString()}`
        }
      }
      return {
        action: { type: 'call', amount: betFacing },
        desc: `${seat.position} calls ${betFacing.toLocaleString()}`
      }
    }

    // Check-raise: villain checked a strong hand, now facing hero's bet
    if (hs.str >= 2 && hs.str < 4) {
      const checkRaiseFreq = hs.str === 3 ? 0.50 : hs.str === 2 ? 0.25 : 0
      if (Math.random() < checkRaiseFreq && seat.stack > betFacing * 2.5) {
        const raiseAmt = Math.min(
          seat.stack,
          Math.round(betFacing * (2.2 + Math.random() * 0.8) / 100) * 100
        )
        return {
          action: { type: 'raise', amount: raiseAmt },
          desc: `${seat.position} raises to ${raiseAmt.toLocaleString()}`,
        }
      }
    }

    // Medium hands: call based on archetype + pot odds + texture (FIX 4)
    if (hs.str >= 2 || (hs.str === 1 && (hs.pairPos === 'toppair' || hs.pairPos === 'overpair'))) {
      const foldThreshold = A.foldToBet - (potOdds * 0.3) + textureFoldAdj
      if (Math.random() > foldThreshold) {
        return {
          action: { type: 'call', amount: betFacing },
          desc: `${seat.position} calls ${betFacing.toLocaleString()}`
        }
      }
      return {
        action: { type: 'fold' },
        desc: `${seat.position} folds`
      }
    }

    // Draws: call with equity, fold without
    if (hs.heroFD || hs.oesd) {
      if (potOdds < 0.35 || seat.archetype === 'LP' || seat.archetype === 'LA') {
        return {
          action: { type: 'call', amount: betFacing },
          desc: `${seat.position} calls ${betFacing.toLocaleString()}`
        }
      }
    }

    // Weak: mostly fold, LP calls too wide
    if (seat.archetype === 'LP' && Math.random() > 0.6) {
      return {
        action: { type: 'call', amount: betFacing },
        desc: `${seat.position} calls ${betFacing.toLocaleString()}`
      }
    }
    return { action: { type: 'fold' }, desc: `${seat.position} folds` }
  }

  // Checking (no bet facing)

  // FIX 6: River polarization — value bet strong, bluff air, check medium
  if (street === 'river') {
    if (hs.str >= 4) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, hs.str)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
    if (hs.str === 2) {
      const thinValueProb = seat.archetype === 'LA' ? 0.55 : seat.archetype === 'TA' ? 0.35 : 0.20
      if (Math.random() < thinValueProb) {
        const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, hs.str)
        return {
          action: { type: 'raise', amount: betAmt },
          desc: `${seat.position} bets ${betAmt.toLocaleString()}`
        }
      }
      return { action: { type: 'check' }, desc: `${seat.position} checks` }
    }
    if (hs.str === 0 && !hs.heroFD && !hs.oesd) {
      const bluffProb = seat.archetype === 'LA' ? 0.45 : seat.archetype === 'TA' ? 0.20 : 0.10
      if (Math.random() < bluffProb) {
        const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, 0)
        return {
          action: { type: 'raise', amount: betAmt },
          desc: `${seat.position} bets ${betAmt.toLocaleString()}`
        }
      }
    }
    return { action: { type: 'check' }, desc: `${seat.position} checks` }
  }

  // Strong hands: bet for value (FIX 5: betFrequency variable)
  if (hs.str >= 3) {
    const betFrequency = isAggressor ? 0.85 : isWet ? 0.45 : 0.70
    if (Math.random() < betFrequency) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, hs.str)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
    return { action: { type: 'check' }, desc: `${seat.position} checks` }
  }

  // Top pair / overpair: bet based on archetype
  if (hs.str === 1 && (hs.pairPos === 'toppair' || hs.pairPos === 'overpair')) {
    const betProb = seat.archetype === 'LA' ? 0.7 : seat.archetype === 'TA' ? 0.55 : seat.archetype === 'LP' ? 0.3 : 0.2
    if (Math.random() < betProb) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, hs.str)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
    return { action: { type: 'check' }, desc: `${seat.position} checks` }
  }

  // FIX 4: Semi-bluff draws (river already handled above)
  if (hs.heroFD || hs.oesd) {
    const semiBluffProb = isWet ? 0.55 : 0.30
    const archAdj = seat.archetype === 'LA' ? 0.15 : seat.archetype === 'TA' ? 0.05 : 0
    if (Math.random() < semiBluffProb + archAdj) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, 0)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
  }

  // FIX 4: Thin value with second/bottom pair
  if (hs.str === 1 && hs.pairPos !== 'toppair' && hs.pairPos !== 'overpair') {
    const thinValueProb = seat.archetype === 'LA' ? 0.40 : seat.archetype === 'TA' ? 0.25 : 0.15
    if (Math.random() < thinValueProb) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, 1)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
  }

  // LA bluffs sometimes (river already handled above)
  if (seat.archetype === 'LA' && hs.str === 0) {
    if (Math.random() < 0.28) {
      const betAmt = villainBetSize(seat.archetype, pot, seat.stack, street, 0)
      return {
        action: { type: 'raise', amount: betAmt },
        desc: `${seat.position} bets ${betAmt.toLocaleString()}`
      }
    }
  }

  return { action: { type: 'check' }, desc: `${seat.position} checks` }
}

// ─────────────────────────────────────────────────────────────
// PREFLOP VILLAIN DECISION
// ─────────────────────────────────────────────────────────────

function resolveVillainPreflop(
  seat: Seat,
  levelIndex: number,
  currentBet: number,
  pot: number,
  limpers: number,
  raisers: number,
  bb: number,
): { action: PlayerAction; desc: string; handRange: string[] | null } {
  const depth = getBBDepth(seat.stack, levelIndex)
  const deepRanges = getRanges(seat.position, depth)
  const shoveRanges = depth < 20 ? getShoveRanges(seat.position, depth) : null

  // Seat already has holeCards dealt — evaluate them
  const holeCards = seat.holeCards
  if (!holeCards) {
    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  const handStr = cardToHandStr(holeCards[0], holeCards[1])

  const inRFI    = deepRanges.rfi.includes(handStr)
  const inCall   = deepRanges.vsRaiseCall.includes(handStr)
  const in3bet   = deepRanges.threebet.includes(handStr)
  const inVs3bet = deepRanges.vs3betCall.includes(handStr)
  const in4bet   = deepRanges.fourbet?.includes(handStr) ?? false
  const inShove  = shoveRanges?.shove.includes(handStr) ?? false

  // ── NO PRIOR ACTION (first to act, no limpers) ────────────
  if (currentBet === bb && raisers === 0 && limpers === 0) {
    if (inRFI) {
      const openFreq = seat.archetype === 'LA' ? 0.90 :
                       seat.archetype === 'LP' ? 0.80 :
                       seat.archetype === 'TA' ? 0.85 :
                       0.70  // TP
      if (Math.random() < openFreq) {
        const openSize = getOpenSize(levelIndex, seat.stack,
          ['CO', 'BTN', 'HJ'].includes(seat.position))
        return {
          action: { type: 'raise', amount: openSize },
          desc: `${seat.position} raises to ${openSize.toLocaleString()}`,
          handRange: deepRanges.rfi,
        }
      }
    }
    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  // ── FACING LIMPERS ONLY (no raise) ────────────────────────
  if (currentBet === bb && raisers === 0 && limpers > 0) {
    if (inRFI && Math.random() > 0.35) {
      const isoSize = getOpenSize(levelIndex, seat.stack, false) +
        (limpers * Math.round(bb * 0.5))
      return {
        action: { type: 'raise', amount: isoSize },
        desc: `${seat.position} raises to ${isoSize.toLocaleString()}`,
        handRange: deepRanges.rfi,
      }
    }
    if (inRFI || inCall) {
      return {
        action: { type: 'limp', amount: bb },
        desc: `${seat.position} calls ${bb.toLocaleString()}`,
        handRange: deepRanges.vsRaiseCall,
      }
    }
    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  // ── FACING A SINGLE RAISE ──────────────────────────────────
  if (raisers === 1) {
    const coldCallPenalty = Math.min(0.20, limpers * 0.07)

    if (in3bet && Math.random() > (0.20 + coldCallPenalty)) {
      // Same formula as hero: 2.5x raise + 1 unit per caller
      const rawThreeBet = Math.round(currentBet * (2.5 + limpers) / 100) * 100
      const threeBet = Math.min(seat.stack, rawThreeBet)
      return {
        action: { type: 'raise', amount: threeBet },
        desc: `${seat.position} ${raiseLabel(1)} to ${threeBet.toLocaleString()}`,
        handRange: deepRanges.threebet,
      }
    }

    if (inCall && Math.random() > coldCallPenalty) {
      return {
        action: { type: 'call', amount: currentBet },
        desc: `${seat.position} calls ${currentBet.toLocaleString()}`,
        handRange: deepRanges.vsRaiseCall,
      }
    }

    if (inShove && depth < 20) {
      return {
        action: { type: 'shove', amount: seat.stack },
        desc: `${seat.position} shoves ${seat.stack.toLocaleString()}`,
        handRange: shoveRanges?.shove ?? deepRanges.rfi,
      }
    }

    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  // ── FACING A 3-BET ────────────────────────────────────────
  if (raisers === 2) {
    const isOriginalOpener = seat.invested > 0
    const baseFoldProb = isOriginalOpener ? 0.60 : 0.93
    const archFoldAdj = seat.archetype === 'LP' ? -0.05 :
                        seat.archetype === 'LA' ? -0.08 :
                        seat.archetype === 'TP' ? 0.04 : 0

    if (in4bet && seat.stack > currentBet * 2.2) {
      const fourBetSize = Math.round(currentBet * 2.3 / 100) * 100
      const actual4bet = Math.min(fourBetSize, seat.stack)
      return {
        action: { type: 'raise', amount: actual4bet },
        desc: `${seat.position} ${raiseLabel(2)} to ${actual4bet.toLocaleString()}`,
        handRange: deepRanges.fourbet,
      }
    }

    if (inVs3bet && Math.random() > (baseFoldProb + archFoldAdj)) {
      return {
        action: { type: 'call', amount: currentBet },
        desc: `${seat.position} calls ${currentBet.toLocaleString()}`,
        handRange: deepRanges.vs3betCall,
      }
    }

    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  // ── FACING A 4-BET OR MORE ────────────────────────────────
  if (raisers >= 3) {
    if (in4bet && Math.random() > 0.30) {
      return {
        action: { type: 'shove', amount: seat.stack },
        desc: `${seat.position} shoves ${seat.stack.toLocaleString()}`,
        handRange: deepRanges.fourbet,
      }
    }
    return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
  }

  return { action: { type: 'fold' }, desc: `${seat.position} folds`, handRange: null }
}

// ─────────────────────────────────────────────────────────────
// HERO OPTION GENERATION
// Generate quality-rated options for hero based on situation
// ─────────────────────────────────────────────────────────────

function r100(n: number): number {
  return Math.round(n / 100) * 100
}

export function scoreSequence(seq: string[]): { strength: number; description: string } {
  const key = seq.join('_')

  // ── FOLDED ───────────────────────────────────────────────────
  if (seq.length === 0 || seq[0] === 'fold') {
    return { strength: 0, description: 'Folded' }
  }

  // ── PREFLOP ONLY ─────────────────────────────────────────────
  const PREFLOP_ONLY: Record<string, [number, string]> = {
    'limp':   [3, 'Limped — small pairs, speculative hands, weak aces'],
    'call':   [5, 'Called a raise — pairs, suited broadways, connectors'],
    'rfi':    [5, 'Opened — full position-based opening range'],
    '3bet':   [7, '3-bet — premiums plus some suited bluffs (AK, QQ+, A5s)'],
    '3bet_c': [7, '3-bet, called 4-bet — KK, AA, QQ, AK'],
    '4bet':   [9, '4-bet — AA, KK, QQ, AK'],
    '4bet_c': [9, '4-bet, called 5-bet — AA, KK'],
    'shove':  [9, 'Shoved preflop — premium at depth or short stack'],
  }
  if (PREFLOP_ONLY[key]) {
    const [s, d] = PREFLOP_ONLY[key]
    return { strength: s, description: d }
  }

  // ── FLOP FOLDS ───────────────────────────────────────────────
  const FLOP_FOLD: Record<string, [number, string]> = {
    'limp_f':   [0, 'Limped, folded flop'],
    'call_xf':  [0, 'Called preflop, check-folded flop'],
    'call_b_f': [0, 'Called preflop, donk bet, folded to raise'],
    'rfi_b_f':  [0, 'C-bet flop, folded to raise'],
    'rfi_xf':   [0, 'Opened, check-folded flop'],
    '3bet_b_f': [0, '3-bet pot c-bet, folded to raise'],
    '3bet_xf':  [0, '3-bet, check-folded flop'],
    'limp_xf':  [0, 'Limped, check-folded flop'],
    'limp_b_f': [0, 'Limped, donk bet, folded to raise'],
  }
  if (FLOP_FOLD[key]) {
    const [s, d] = FLOP_FOLD[key]
    return { strength: s, description: d }
  }

  // ── FLOP COMPLETE ────────────────────────────────────────────
  const FLOP_COMPLETE: Record<string, [number, string]> = {
    'rfi_b':   [5, 'C-bet flop — top pair+, strong draws, some air bluffs'],
    'rfi_x':   [3, 'Checked flop — middle pairs, backdoors, some traps'],
    'rfi_xc':  [4, 'Checked flop, called hero bet — medium strength, draws'],
    'rfi_xr':  [8, 'Check-raised flop — sets, two pair, big combo draws'],
    'rfi_c':   [4, 'Called flop bet — medium pairs, draws'],
    'call_b':  [6, 'Donk bet flop — usually strong OOP hand'],
    'call_xc': [4, 'Check-called flop — medium pairs, draws, floating'],
    'call_xr': [8, 'Check-raised flop — sets, two pair, big draws'],
    'call_c':  [4, 'Called c-bet — medium pairs, draws, floating'],
    '3bet_b':  [6, 'C-bet in 3-bet pot — overpairs, top pair, some air'],
    '3bet_x':  [4, 'Checked 3-bet pot — medium strength or rare trap'],
    '3bet_xc': [5, 'Check-called in 3-bet pot — medium strong, draws'],
    '3bet_xr': [9, 'Check-raised in 3-bet pot — very strong, sets, two pair'],
    '3bet_c':  [5, 'Called in 3-bet pot — medium strong hand'],
    'limp_b':  [5, 'Bet after limping — medium strength'],
    'limp_xc': [3, 'Check-called after limping — medium weak'],
    'limp_xr': [7, 'Check-raised after limping — strong, trapping'],
    'limp_c':  [3, 'Called after limping — medium weak'],
  }
  if (FLOP_COMPLETE[key]) {
    const [s, d] = FLOP_COMPLETE[key]
    return { strength: s, description: d }
  }

  // ── TURN ─────────────────────────────────────────────────────
  const TURN: Record<string, [number, string]> = {
    'rfi_b_c_b':   [7, 'Called c-bet, bet turn — strong pair+, turned equity'],
    'rfi_b_c_x':   [3, 'Called c-bet, checked turn — gave up, medium weak'],
    'rfi_b_c_r':   [9, 'Called c-bet, raised turn — two pair+, sets, made draws'],
    'rfi_b_c_f':   [0, 'Called c-bet, folded turn'],
    'rfi_b_c_xc':  [3, 'Called c-bet, check-called turn — medium, draw, stubborn'],
    'rfi_b_c_xr':  [9, 'Called c-bet, check-raised turn — trapping, very strong'],
    'rfi_b_c_xf':  [0, 'Called c-bet, check-folded turn'],
    'rfi_b_b':     [7, 'Double barreled — strong value, committed range'],
    'rfi_b_x':     [3, 'C-bet flop, checked turn — gave up bluffs, showdown value'],
    'rfi_x_b':     [5, 'Checked flop, bet turn — delayed c-bet, medium-strong'],
    'rfi_x_x':     [2, 'Checked both streets — very weak or rare deep trap'],
    'rfi_x_c':     [4, 'Checked flop, called turn — medium, pot control'],
    'rfi_x_r':     [8, 'Checked flop, raised turn — trapping, very strong'],
    'rfi_x_xc':    [3, 'Check-check flop, check-called turn — medium weak'],
    'rfi_x_xr':    [9, 'Check-check flop, check-raised turn — massive trap'],
    'rfi_x_xf':    [0, 'Check-check flop, check-folded turn'],
    'rfi_xc_b':    [6, 'Check-called flop, bet turn — improved, strong'],
    'rfi_xc_x':    [3, 'Check-called flop, checked turn — medium weak'],
    'rfi_xc_r':    [9, 'Check-called flop, raised turn — very strong'],
    'rfi_xc_f':    [0, 'Check-called flop, folded turn'],
    'rfi_xc_xc':   [3, 'Check-called both streets — weak, stubborn'],
    'rfi_xc_xr':   [9, 'Check-called flop, check-raised turn — trap'],
    'rfi_xc_xf':   [0, 'Check-called flop, check-folded turn'],
    'rfi_xc_c':    [4, 'Check-called flop, called turn bet — medium'],
    'rfi_xr_b':    [9, 'Check-raised flop, bet turn — very strong, value'],
    'rfi_xr_x':    [5, 'Check-raised flop, checked turn — semi-bluff missed'],
    'rfi_xr_c':    [8, 'Check-raised flop, called turn — strong, committed'],
    'rfi_xr_r':    [10,'Check-raised flop, raised turn — absolute nuts'],
    'rfi_xr_xc':   [6, 'Check-raised flop, check-called turn — draw or strong'],
    'rfi_xr_xr':   [10,'Check-raised flop, check-raised turn — nutted'],
    'call_xc_b':   [6, 'Check-called flop, bet turn — drew out or strong'],
    'call_xc_x':   [3, 'Check-called flop, checked turn — gave up, medium weak'],
    'call_xc_r':   [9, 'Check-called flop, raised turn — two pair+, very strong'],
    'call_xc_f':   [0, 'Check-called flop, folded turn'],
    'call_xc_xc':  [4, 'Check-called both streets — medium, draw, committed'],
    'call_xc_xr':  [9, 'Check-called flop, check-raised turn — trap'],
    'call_xc_xf':  [0, 'Check-called flop, check-folded turn'],
    'call_xc_c':   [4, 'Check-called both streets — medium committed'],
    'call_xr_b':   [9, 'Check-raised flop, bet turn — very strong value'],
    'call_xr_x':   [5, 'Check-raised flop, checked turn — semi-bluff draw missed'],
    'call_xr_c':   [8, 'Check-raised flop, called turn — strong, committed'],
    'call_xr_r':   [10,'Check-raised flop, raised turn — absolute nuts'],
    'call_xr_xc':  [6, 'Check-raised flop, check-called turn — draw or strong'],
    'call_xr_xr':  [10,'Check-raised flop, check-raised turn — nutted'],
    'call_xr_xf':  [0, 'Check-raised flop, check-folded turn'],
    'call_b_b':    [7, 'Donk bet flop and turn — strong value'],
    'call_b_x':    [4, 'Donk bet flop, checked turn — pot control or gave up'],
    'call_b_c':    [6, 'Donk bet flop, called turn raise — committed strong'],
    'call_b_r':    [9, 'Donk bet flop, raised turn — two pair+'],
    'call_b_xc':   [4, 'Donk bet flop, check-called turn — medium'],
    'call_b_xr':   [9, 'Donk bet flop, check-raised turn — trap'],
    'call_b_xf':   [0, 'Donk bet flop, check-folded turn'],
    '3bet_b_c_b':  [8, 'Called 3-bet c-bet, bet turn — very strong'],
    '3bet_b_c_x':  [4, 'Called 3-bet c-bet, checked turn — gave up'],
    '3bet_b_c_r':  [10,'Called 3-bet c-bet, raised turn — nutted'],
    '3bet_b_c_xc': [5, 'Called 3-bet c-bet, check-called turn'],
    '3bet_b_c_xr': [10,'Called 3-bet c-bet, check-raised turn — nutted'],
    '3bet_b_c_xf': [0, 'Called 3-bet c-bet, check-folded turn'],
    '3bet_b_b':    [8, 'Double barrel in 3-bet pot — strong value'],
    '3bet_b_x':    [4, 'C-bet 3-bet pot, checked turn — gave up bluffs'],
    '3bet_x_b':    [6, 'Checked 3-bet flop, bet turn — delayed value'],
    '3bet_x_x':    [2, 'Checked both streets in 3-bet pot — very unusual'],
    '3bet_x_c':    [5, 'Checked 3-bet flop, called turn'],
    '3bet_x_r':    [9, 'Checked 3-bet flop, raised turn — trapping'],
    '3bet_x_xc':   [4, 'Checked 3-bet flop, check-called turn'],
    '3bet_x_xr':   [10,'Checked 3-bet flop, check-raised turn — nutted'],
    '3bet_xc_b':   [6, 'Check-called 3-bet flop, bet turn — strong'],
    '3bet_xc_x':   [3, 'Check-called 3-bet flop, checked turn'],
    '3bet_xc_r':   [10,'Check-called 3-bet flop, raised turn — nutted'],
    '3bet_xc_xc':  [5, 'Check-called both streets in 3-bet pot'],
    '3bet_xc_xr':  [10,'Check-called 3-bet flop, check-raised turn — nutted'],
    'limp_xc_b':   [5, 'Limped, check-called flop, bet turn'],
    'limp_xc_x':   [2, 'Limped, check-called flop, checked turn — weak'],
    'limp_xc_r':   [8, 'Limped, check-called flop, raised turn — strong'],
    'limp_xc_xc':  [3, 'Limped, check-called both streets — weak'],
    'limp_xc_xr':  [8, 'Limped, check-called flop, check-raised turn'],
    'limp_xc_xf':  [0, 'Limped, check-called flop, check-folded turn'],
    'limp_b_b':    [6, 'Limped, bet flop and turn — medium-strong'],
    'limp_b_x':    [3, 'Limped, bet flop, checked turn — gave up'],
    'limp_b_c':    [5, 'Limped, bet flop, called turn — committed'],
    'limp_b_r':    [8, 'Limped, bet flop, raised turn — two pair+'],
    'limp_xr_b':   [7, 'Limped, check-raised flop, bet turn — strong'],
    'limp_xr_x':   [4, 'Limped, check-raised flop, checked turn — semi-bluff'],
    'limp_xr_c':   [7, 'Limped, check-raised flop, called turn — strong'],
    'limp_xr_r':   [10,'Limped, check-raised flop, raised turn — nutted'],
  }
  if (TURN[key]) {
    const [s, d] = TURN[key]
    return { strength: s, description: d }
  }

  // ── RIVER ────────────────────────────────────────────────────
  const RIVER: Record<string, [number, string]> = {
    'rfi_b_c_r_b':    [9,  'Raised turn, bet river — strong value betting'],
    'rfi_b_c_r_x':    [7,  'Raised turn, checked river — pot control or trap'],
    'rfi_b_c_r_c':    [8,  'Raised turn, called river — strong hand calling down'],
    'rfi_b_c_r_r':    [10, 'Raised turn, raised river — absolute nuts'],
    'rfi_b_c_r_xc':   [7,  'Raised turn, check-called river — strong showdown'],
    'rfi_b_c_r_xr':   [10, 'Raised turn, check-raised river — nutted'],
    'rfi_b_c_r_xf':   [0,  'Raised turn, check-folded river'],
    'rfi_b_c_r_f':    [0,  'Raised turn, folded river'],
    'call_xr_b_b':    [10, 'Check-raised flop, bet turn, bet river — value'],
    'call_xr_b_x':    [7,  'Check-raised flop, bet turn, checked river'],
    'call_xr_b_c':    [9,  'Check-raised flop, bet turn, called river'],
    'call_xr_b_r':    [10, 'Check-raised flop, bet turn, raised river — nuts'],
    'call_xr_b_xc':   [8,  'Check-raised flop, bet turn, check-called river'],
    'call_xr_b_xr':   [10, 'Check-raised flop, bet turn, check-raised river'],
    'call_xr_b_f':    [0,  'Check-raised flop, bet turn, folded river'],
    'rfi_b_c_b_b':    [8,  'Called c-bet, bet turn, bet river — strong value'],
    'rfi_b_c_b_x':    [5,  'Called c-bet, bet turn, checked river — showdown'],
    'rfi_b_c_b_c':    [7,  'Called c-bet, bet turn, called river — medium-strong'],
    'rfi_b_c_b_r':    [9,  'Called c-bet, bet turn, raised river — polarized'],
    'rfi_b_c_b_xc':   [6,  'Called c-bet, bet turn, check-called river'],
    'rfi_b_c_b_xr':   [9,  'Called c-bet, bet turn, check-raised river'],
    'rfi_b_c_b_f':    [0,  'Called c-bet, bet turn, folded river'],
    'rfi_b_c_b_xf':   [0,  'Called c-bet, bet turn, check-folded river'],
    'rfi_b_b_b':      [8,  'Triple barrel — strong value or committed bluff'],
    'rfi_b_b_x':      [5,  'Double barrel, checked river — gave up or showdown'],
    'rfi_b_b_c':      [7,  'Double barrel, called river — medium-strong'],
    'rfi_b_b_r':      [9,  'Double barrel, raised river — polarized nuts or bluff'],
    'rfi_b_b_xc':     [6,  'Double barrel, check-called river'],
    'rfi_b_b_xr':     [9,  'Double barrel, check-raised river — polarized'],
    'rfi_b_b_f':      [0,  'Double barrel, folded river'],
    'rfi_b_b_xf':     [0,  'Double barrel, check-folded river'],
    'call_xc_b_b':    [7,  'Check-called flop, bet turn, bet river — value'],
    'call_xc_b_x':    [4,  'Check-called flop, bet turn, checked river'],
    'call_xc_b_c':    [6,  'Check-called flop, bet turn, called river'],
    'call_xc_b_r':    [9,  'Check-called flop, bet turn, raised river — strong'],
    'call_xc_b_xc':   [5,  'Check-called flop, bet turn, check-called river'],
    'call_xc_b_xr':   [9,  'Check-called flop, bet turn, check-raised river'],
    'call_xc_b_f':    [0,  'Check-called flop, bet turn, folded river'],
    'call_xc_xc_b':   [5,  'Check-called both, bet river — value or bluff'],
    'call_xc_xc_x':   [3,  'Check-called both, checked river — showdown weak'],
    'call_xc_xc_c':   [4,  'Check-called both, called river'],
    'call_xc_xc_r':   [8,  'Check-called both, raised river — polarized'],
    'call_xc_xc_xc':  [4,  'Check-called all three streets — stubborn medium'],
    'call_xc_xc_xr':  [9,  'Check-called both, check-raised river — trap'],
    'call_xc_xc_f':   [0,  'Check-called both, folded river'],
    'rfi_x_x_b':      [5,  'Checked both, bet river — bluff or hidden value'],
    'rfi_x_x_x':      [1,  'Checked all three streets — very weak, pure showdown'],
    'rfi_x_x_c':      [3,  'Checked both, called river bet — weak showdown value'],
    'rfi_x_x_r':      [8,  'Checked both, raised river — polarized trap or bluff'],
    'rfi_x_x_xc':     [3,  'Checked both, check-called river — weak'],
    'rfi_x_x_xr':     [8,  'Checked both, check-raised river — disguised strong'],
    'rfi_x_x_f':      [0,  'Checked both, folded river'],
    'rfi_x_x_xf':     [0,  'Checked both, check-folded river'],
    '3bet_b_b_b':     [9,  'Triple barrel in 3-bet pot — strong value'],
    '3bet_b_b_x':     [6,  'Double barrel 3-bet pot, checked river'],
    '3bet_b_b_c':     [8,  'Double barrel 3-bet pot, called river'],
    '3bet_b_b_r':     [10, 'Double barrel 3-bet pot, raised river — nuts'],
    '3bet_b_b_xc':    [7,  'Double barrel 3-bet pot, check-called river'],
    '3bet_b_b_xr':    [10, 'Double barrel 3-bet pot, check-raised river — nuts'],
    '3bet_b_c_b_b':   [9,  'Called 3-bet c-bet, bet turn, bet river — very strong'],
    '3bet_b_c_b_x':   [6,  'Called 3-bet c-bet, bet turn, checked river'],
    '3bet_b_c_b_r':   [10, 'Called 3-bet c-bet, bet turn, raised river — nuts'],
    '3bet_b_c_b_xc':  [8,  'Called 3-bet c-bet, bet turn, check-called river'],
    '3bet_b_c_r_b':   [10, 'Called 3-bet c-bet, raised turn, bet river — nuts'],
    '3bet_b_c_r_x':   [8,  'Called 3-bet c-bet, raised turn, checked river'],
    '3bet_b_c_r_c':   [9,  'Called 3-bet c-bet, raised turn, called river'],
    'limp_xc_b_b':    [6,  'Limped, check-called flop, bet turn, bet river'],
    'limp_xc_b_x':    [3,  'Limped, check-called flop, bet turn, checked river'],
    'limp_xc_b_c':    [5,  'Limped, check-called flop, bet turn, called river'],
    'limp_xc_b_r':    [8,  'Limped, check-called flop, bet turn, raised river'],
    'limp_xc_xc_b':   [4,  'Limped, check-called both, bet river'],
    'limp_xc_xc_x':   [2,  'Limped, check-called both, checked river — weak'],
    'limp_xc_xc_c':   [3,  'Limped, check-called both, called river'],
    'limp_xc_xc_r':   [7,  'Limped, check-called both, raised river'],
    'limp_b_b_b':     [7,  'Limped, bet all three streets — medium-strong value'],
    'limp_b_b_x':     [4,  'Limped, bet flop and turn, checked river'],
    'limp_b_b_c':     [6,  'Limped, bet flop and turn, called river'],
    'limp_b_b_r':     [8,  'Limped, bet flop and turn, raised river'],
  }
  if (RIVER[key]) {
    const [s, d] = RIVER[key]
    return { strength: s, description: d }
  }

  // ── FALLBACK for novel sequences ─────────────────────────────
  const riverAction = seq[seq.length - 1]
  const fallback = scoreSequence(seq.slice(0, -1))
  let str = fallback.strength
  let desc = fallback.description
  if (riverAction === 'b' || riverAction === 'r') {
    str = Math.min(10, str + 1); desc += ' → bet/raise'
  } else if (riverAction === 'x') {
    str = Math.max(1, str - 2); desc += ' → checked'
  } else if (riverAction === 'xr') {
    str = Math.max(str, 8); desc += ' → check-raised (polarized)'
  } else if (riverAction === 'c' || riverAction === 'xc') {
    desc += ' → called'
  } else if (riverAction === 'f' || riverAction === 'xf') {
    return { strength: 0, description: desc + ' → folded' }
  }
  return { strength: Math.max(0, Math.min(10, str)), description: desc }
}

function updatePrimaryVillain(engine: HandEngine): void {
  const active = engine.villainProfiles.filter(p =>
    p.rangeStrength > 0 &&
    !engine.seats.find(s => s.seatIndex === p.seatIndex)?.folded
  )
  engine.villainProfiles.forEach(p => { p.isPrimary = false })
  if (active.length === 0) {
    engine.primaryVillain = null
    return
  }
  const primary = active.reduce((best, p) =>
    p.rangeStrength > best.rangeStrength ? p : best
  , active[0])
  primary.isPrimary = true
  engine.primaryVillain = primary
}

function generateHeroOptions(
  heroSeat: Seat,
  board: Card[],
  pot: number,
  currentBet: number,    // 0 if hero can check, >0 if facing a bet/raise
  street: Street,
  levelIndex: number,
  playersLeft: number,
  lastAggressor: Seat | null,
  raisers: number,
  limpers: number,
  activeSeats?: Seat[],
  streetHistory?: Array<{ street: string; heroAction: string; pot: number }>,
  villainRangeStrength?: number,
  villainRangeDesc?: string,
): HeroOption[] {
  const bb = getBB(levelIndex)
  const depth = getBBDepth(heroSeat.stack, levelIndex)
  const ranges = getRanges(heroSeat.position, depth)
  const nearBubble = isNearBubble(playersLeft)
  const options: HeroOption[] = []
  const heroHandStr = heroSeat.holeCards
    ? cardToHandStr(heroSeat.holeCards[0], heroSeat.holeCards[1])
    : ''

  // ── PREFLOP ──────────────────────────────────────────────
  if (street === 'preflop') {
    const inRFI     = ranges.rfi.includes(heroHandStr)
    const inCall    = ranges.vsRaiseCall.includes(heroHandStr)
    const in3bet    = ranges.threebet.includes(heroHandStr)
    const inVs3bet  = ranges.vs3betCall.includes(heroHandStr)
    const in4bet    = (ranges.fourbet ?? []).includes(heroHandStr)
    const shoveRanges = depth < 20 ? getShoveRanges(heroSeat.position, depth) : null
    const inShove   = shoveRanges?.shove.includes(heroHandStr) ?? false
    const isSqueeze = raisers === 1 && limpers >= 1
    const inSqueezeRange = isSqueeze && (inCall || inRFI) &&
      (heroHandStr.endsWith('s') || ['99','88','77','AJo','KQo'].includes(heroHandStr))

    // Hand properties for quality decisions
    const RANK_ORDER = 'AKQJT98765432'.split('')
    const c1 = heroSeat.holeCards![0]
    const c2 = heroSeat.holeCards![1]
    const i1 = RANK_ORDER.indexOf(c1.r)
    const i2 = RANK_ORDER.indexOf(c2.r)
    const hiIdx  = Math.min(i1, i2)
    const loIdx  = Math.max(i1, i2)
    const isPair   = c1.r === c2.r
    const isSuited = c1.s === c2.s
    const gap      = loIdx - hiIdx
    const isLP  = ['BTN', 'CO', 'HJ'].includes(heroSeat.position)
    const isOOP = ['SB', 'BB', 'UTG', 'UTG1', 'UTG2'].includes(heroSeat.position)

    // Sizing
    const depthMult = depth > 100 ? 3.0 : depth > 75 ? 2.5 : depth > 50 ? 2.2 : 2.0
    const oopBonus  = isOOP ? 0.3 : 0.0
    const stdMult   = depthMult + oopBonus
    const rfiStd        = r100(bb * stdMult)
    const rfiLarge      = r100(bb * (stdMult + 0.5))
    const threeBetStd   = r100(currentBet * (2.5 + limpers))
    const threeBetLarge = r100(currentBet * (3.0 + limpers))
    const fourBetStd    = r100(currentBet * 2.3)
    const callCost = Math.min(heroSeat.stack, Math.max(0, currentBet - heroSeat.invested))
    const limpCost = Math.min(heroSeat.stack, Math.max(0, bb - heroSeat.invested))
    const threeBetCommitsStack =
      threeBetStd > heroSeat.stack * 0.4 ||
      (heroSeat.stack - threeBetStd) < bb * 12

    // ── SCENARIO: FIRST IN ───────────────────────────────
    if (raisers === 0 && heroSeat.position !== 'BB') {

      // 1. FOLD
      const foldQuality: Quality =
        inRFI ? 'bad' :
        (isSuited && gap <= 3 && isLP) ? 'ok' :
        'best'
      options.push({
        label: 'Fold',
        type: 'fold',
        amount: 0,
        chipCost: 0,
        quality: foldQuality,
        coaching: foldQuality === 'bad'
          ? `${heroHandStr} is in your opening range from ${heroSeat.position}. Raise for value and initiative.`
          : foldQuality === 'ok'
          ? `${heroHandStr} is borderline. Folding is fine but a small raise is also reasonable.`
          : `Correct fold. ${heroHandStr} is outside your range from ${heroSeat.position}.`,
      })

      // 2. LIMP (call BB)
      if (limpCost > 0) {
        const limpQuality: Quality =
          (isPair && hiIdx >= 7 && isLP) ? 'ok' :
          (isSuited && gap <= 2 && isLP) ? 'ok' :
          'bad'
        options.push({
          label: heroSeat.position === 'SB'
            ? `Complete ${limpCost.toLocaleString()}`
            : `Call ${limpCost.toLocaleString()} (limp)`,
          type: 'call',
          amount: bb,
          chipCost: limpCost,
          quality: limpQuality,
          coaching: limpQuality === 'ok'
            ? `Limping ${heroHandStr} in LP is a low-frequency solver play. Raising is usually better but this is defensible.`
            : `Limping ${heroHandStr} leaks value. Raise for initiative or fold — limping invites multiway pots where your hand plays poorly.`,
        })
      }

      // 3. RAISE STANDARD
      if (rfiStd < heroSeat.stack) {
        const raiseStdQuality: Quality =
          inRFI ? 'best' :
          (isSuited && gap <= 3 && isLP) ? 'ok' :
          'bad'
        options.push({
          label: `Raise to ${rfiStd.toLocaleString()}`,
          type: 'raise',
          amount: rfiStd,
          chipCost: Math.max(0, rfiStd - heroSeat.invested),
          quality: raiseStdQuality,
          coaching: raiseStdQuality === 'best'
            ? `Standard open from ${heroSeat.position}. ${heroHandStr} is in range — raise and take initiative.`
            : raiseStdQuality === 'ok'
            ? `Marginal open. ${heroHandStr} has some playability from ${heroSeat.position} but is borderline.`
            : `Do not open ${heroHandStr} from ${heroSeat.position}. This hand is outside your range.`,
        })
      }

      // 4. RAISE LARGE (depth ≥ 20) or SHOVE (depth < 20)
      if (depth > 50 && rfiLarge < heroSeat.stack && rfiLarge !== rfiStd) {
        options.push({
          label: `Raise to ${rfiLarge.toLocaleString()} (large)`,
          type: 'raise',
          amount: rfiLarge,
          chipCost: Math.max(0, rfiLarge - heroSeat.invested),
          quality: inRFI ? 'good' : 'bad',
          coaching: inRFI
            ? `Larger sizing builds a bigger pot. Fine with strong hands but standard sizing is preferred for balance.`
            : `Raising large with ${heroHandStr} outside your range compounds the mistake.`,
        })
      } else if (depth < 20) {
        // Short stack: shove replaces Raise Large as option 4
        options.push({
          label: `Shove ${heroSeat.stack.toLocaleString()}`,
          type: 'shove',
          amount: heroSeat.stack,
          chipCost: heroSeat.stack,
          quality: inShove ? 'best' : inRFI ? 'ok' : 'bad',
          coaching: inShove
            ? `Standard shove at ${depth}BB. ${heroHandStr} has enough equity and fold equity to be profitable.`
            : inRFI
            ? `${heroHandStr} is in your opening range but too deep for an immediate shove. Consider a standard open if stack allows.`
            : `Do not shove ${heroHandStr} here — it's outside your shove range at ${depth}BB.`,
        })
      }
    }

    // ── SCENARIO: BB CHECK or RAISE ─────────────────────
    else if (heroSeat.position === 'BB' && raisers === 0) {
      options.push({
        label: limpers > 0 ? 'Check (iso opportunity)' : 'Check — take free flop',
        type: 'check',
        amount: 0,
        chipCost: 0,
        quality: inRFI ? 'ok' : 'best',
        coaching: inRFI
          ? `You can check or raise here. ${heroHandStr} is strong enough to iso-raise the limpers.`
          : `Check and see a free flop with ${heroHandStr}.`,
      })
      if (limpers > 0) {
        const isoStd   = r100(rfiStd + limpers * r100(bb * 0.5))
        const isoLarge = r100(isoStd + bb)
        options.push({
          label: `Raise to ${isoStd.toLocaleString()}`,
          type: 'raise',
          amount: isoStd,
          chipCost: Math.max(0, isoStd - heroSeat.invested),
          quality: inRFI ? 'best' : 'bad',
          coaching: inRFI
            ? `Iso-raise to deny equity to limpers. ${heroHandStr} plays well heads-up.`
            : `Raising ${heroHandStr} from BB over limpers is too loose. Check and see the flop.`,
        })
        options.push({
          label: `Raise to ${isoLarge.toLocaleString()} (large)`,
          type: 'raise',
          amount: isoLarge,
          chipCost: Math.max(0, isoLarge - heroSeat.invested),
          quality: inRFI ? 'good' : 'bad',
          coaching: `Larger iso-raise charges limpers more. Use with premium hands.`,
        })
      }
    }

    // ── SCENARIO: FACING A RAISE ─────────────────────────
    else if (raisers === 1) {
      // 1. FOLD
      options.push({
        label: 'Fold',
        type: 'fold',
        amount: 0,
        chipCost: 0,
        quality: (inCall || in3bet) ? 'bad' : 'best',
        coaching: (inCall || in3bet)
          ? `${heroHandStr} is in your continuing range. Don't fold — call or 3-bet.`
          : `Correct fold. ${heroHandStr} doesn't have enough equity vs this range.`,
      })

      // 2. CALL
      if (callCost > 0 && callCost < heroSeat.stack) {
        options.push({
          label: `Call ${currentBet.toLocaleString()}`,
          type: 'call',
          amount: currentBet,
          chipCost: callCost,
          quality: (inCall && in3bet) ? 'good' : inCall ? 'best' : 'bad',
          coaching: (inCall && in3bet)
            ? `Calling is fine but 3-betting is slightly better. ${heroHandStr} is in your 3-bet range.`
            : inCall
            ? `Good call. ${heroHandStr} is in your calling range.`
            : `Calling ${heroHandStr} here leaks chips. Fold or 3-bet.`,
        })
      }

      // 3. 3-BET STANDARD
      if (!threeBetCommitsStack && threeBetStd < heroSeat.stack) {
        options.push({
          label: `3-bet to ${threeBetStd.toLocaleString()}`,
          type: 'raise',
          amount: threeBetStd,
          chipCost: threeBetStd,
          quality: in3bet ? 'best' : inSqueezeRange ? 'good' : 'bad',
          coaching: in3bet
            ? isSqueeze
              ? `Squeeze play with ${heroHandStr}. Dead money makes this profitable — 3-bet and pick it up.`
              : `Correct 3-bet. ${heroHandStr} is in your 3-bet range — apply pressure.`
            : inSqueezeRange
            ? `Good squeeze. Dead money from ${limpers} caller${limpers > 1 ? 's' : ''} makes this profitable.`
            : `Don't 3-bet ${heroHandStr}. It's not in your 3-bet range — call or fold.`,
        })
      }

      // 4. 3-BET LARGE
      if (!threeBetCommitsStack && threeBetLarge < heroSeat.stack && threeBetLarge !== threeBetStd) {
        options.push({
          label: `3-bet to ${threeBetLarge.toLocaleString()} (large)`,
          type: 'raise',
          amount: threeBetLarge,
          chipCost: threeBetLarge,
          quality: in3bet ? 'good' : 'bad',
          coaching: `Larger 3-bet sizing. More pressure but standard size is preferred for balance.`,
        })
      }

      // SHOVE when short or 3-bet commits stack
      if (depth < 20 || threeBetCommitsStack) {
        options.push({
          label: `Shove ${heroSeat.stack.toLocaleString()}`,
          type: 'shove',
          amount: heroSeat.stack,
          chipCost: heroSeat.stack,
          quality: in3bet ? 'best' : inCall ? 'ok' : 'bad',
          coaching: in3bet
            ? `Correct shove. ${heroHandStr} at ${depth}BB — maximum fold equity plus hand equity.`
            : inCall
            ? `Marginal shove. ${heroHandStr} has some equity but may be dominated.`
            : `Do not shove ${heroHandStr} here. Too weak to get it in vs this range.`,
        })
      }
    }

    // ── SCENARIO: FACING A 3-BET ─────────────────────────
    else if (raisers === 2) {
      // 1. FOLD
      options.push({
        label: 'Fold',
        type: 'fold',
        amount: 0,
        chipCost: 0,
        quality: (inVs3bet || in4bet) ? 'bad' : 'best',
        coaching: (inVs3bet || in4bet)
          ? `${heroHandStr} is strong enough to continue vs a 3-bet. Don't fold.`
          : `Correct fold. ${heroHandStr} is not strong enough to continue vs a 3-bet.`,
      })

      // 2. CALL
      if (callCost > 0 && callCost < heroSeat.stack) {
        options.push({
          label: `Call ${currentBet.toLocaleString()}`,
          type: 'call',
          amount: currentBet,
          chipCost: callCost,
          quality: inVs3bet ? 'best' : 'bad',
          coaching: inVs3bet
            ? `${heroHandStr} is in your vs-3bet calling range. Good call.`
            : `Calling ${heroHandStr} vs a 3-bet leaks chips. Fold.`,
        })
      }

      // 3. 4-BET STANDARD
      if (in4bet && fourBetStd < heroSeat.stack * 0.8) {
        options.push({
          label: `4-bet to ${fourBetStd.toLocaleString()}`,
          type: 'raise',
          amount: fourBetStd,
          chipCost: fourBetStd,
          quality: 'best',
          coaching: `4-bet with ${heroHandStr}. Applies maximum pressure.`,
        })
      }

      // 4. SHOVE
      options.push({
        label: `Shove ${heroSeat.stack.toLocaleString()}`,
        type: 'shove',
        amount: heroSeat.stack,
        chipCost: heroSeat.stack,
        quality: in4bet ? (depth < 25 ? 'best' : 'good') : inVs3bet ? 'ok' : 'bad',
        coaching: in4bet
          ? `Shoving ${heroHandStr} facing a 3-bet. Maximum pressure.`
          : `Shoving ${heroHandStr} is too aggressive here. 4-bet smaller or call.`,
      })
    }

    // ── SCENARIO: FACING 4-BET+ ──────────────────────────
    else if (raisers >= 3) {
      options.push({
        label: 'Fold',
        type: 'fold',
        amount: 0,
        chipCost: 0,
        quality: in4bet ? 'bad' : 'best',
        coaching: in4bet
          ? `${heroHandStr} is strong enough to shove vs a 4-bet.`
          : `Correct fold. Only continue with QQ+/AK vs a 4-bet.`,
      })
      options.push({
        label: `Shove ${heroSeat.stack.toLocaleString()}`,
        type: 'shove',
        amount: heroSeat.stack,
        chipCost: heroSeat.stack,
        quality: in4bet ? 'best' : 'bad',
        coaching: in4bet
          ? `Mandatory shove with ${heroHandStr}. Never fold a premium facing a 4-bet.`
          : `Shoving ${heroHandStr} vs a 4-bet is too loose. Fold.`,
      })
    }

    return options
  }

  // ── POSTFLOP ─────────────────────────────────────────────
  const hs = heroSeat.holeCards
    ? evalHand(heroSeat.holeCards[0], heroSeat.holeCards[1], board)
    : null

  const texture = board.length >= 3 ? classifyBoardTexture(board) : 'dry'
  const isDry = texture === 'dry'
  const texStrat = BOARD_TEXTURE[texture]
  const nearBubbleNote = nearBubble ? ' ICM pressure: avoid marginal spots.' : ''

  const activePostflop = activeSeats
    ? POSTFLOP_ORDER.filter(pos => activeSeats.some(s => s.position === pos && !s.folded))
    : POSTFLOP_ORDER
  const isIP = activePostflop.length > 0
    ? activePostflop[activePostflop.length - 1] === heroSeat.position
    : ['BTN','CO','HJ'].includes(heroSeat.position)
  const effectiveStack = lastAggressor
    ? Math.min(heroSeat.stack, lastAggressor.stack)
    : heroSeat.stack
  const spr = pot > 0 ? Math.round(effectiveStack / pot * 10) / 10 : 99
  const committed = spr < 2
  // Prior street context for coaching
  const heroRaisedPreflop = streetHistory?.some(
    s => s.street === 'preflop' &&
    (s.heroAction.includes('Raise') || s.heroAction.includes('3-bet') || s.heroAction.includes('raise'))
  ) ?? false
  const heroCalledPreflop = streetHistory?.some(
    s => s.street === 'preflop' && s.heroAction.toLowerCase().includes('call')
  ) ?? false
  const priorBetDesc = streetHistory && streetHistory.length > 0
    ? ` (You ${streetHistory[streetHistory.length - 1].heroAction.toLowerCase()} on the ${streetHistory[streetHistory.length - 1].street}.)`
    : ''

  const heroDonking = lastAggressor !== null &&
    lastAggressor.seatIndex !== heroSeat.seatIndex &&
    !isIP && currentBet === 0 &&
    !heroRaisedPreflop

  // Villain range tiers derived from tracking
  const vs = villainRangeStrength ?? 5
  const villainStrong = vs >= 8
  const villainWeak   = vs < 5
  const villainRaisedLastStreet = !!(villainRangeDesc && (
    villainRangeDesc.includes('raised') ||
    villainRangeDesc.includes('check-raised') ||
    villainRangeDesc.includes('raised turn') ||
    villainRangeDesc.includes('raised flop')
  ))
  const villainContext = villainRangeDesc && villainRangeDesc !== 'Preflop range unknown'
    ? ` Villain's line: ${villainRangeDesc}.` : ''

  // True when hero has an overpair but the board has a higher card
  const boardHasDangerCard = hs !== null &&
    hs.pairPos === 'overpair' &&
    board.some(c => {
      const RV: Record<string, number> = {
        'A':14,'K':13,'Q':12,'J':11,'T':10,
        '9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2,
      }
      return RV[c.r] > (hs?.pairVal ?? 0)
    })

  // Facing a bet
  if (currentBet > 0) {
    const potOdds = currentBet / (pot + currentBet)
    // Fold — draw-aware with pot odds (FIX 3)
    const foldQuality: Quality =
      (hs && (hs.str >= 3 || hs.str >= 2)) ? 'bad' :
      (hs && hs.str === 1 && (hs.pairPos === 'toppair' || hs.pairPos === 'overpair')) ? 'bad' :
      (hs && hs.heroNFD && hs.oesd) ? 'bad' :
      (hs && (hs.heroNFD || (hs.heroFD && potOdds < 0.30))) ? 'ok' :
      (hs && hs.oesd && potOdds < 0.35) ? 'ok' :
      (hs && hs.str === 0 && !hs.heroFD && !hs.oesd) ? 'best' :
      'ok'
    options.push({
      label: 'Fold',
      type: 'fold',
      amount: 0,
      chipCost: 0,
      quality: foldQuality,
      coaching: foldQuality === 'best'
        ? `Correct fold. ${hs?.label || 'Your hand'} has no equity here.${nearBubbleNote}`
        : foldQuality === 'bad'
        ? `Don't give up ${hs?.label || 'this hand'}. You have too much equity to fold.`
        : `Marginal spot. Pot odds ${Math.round(potOdds * 100)}% — consider your draws before folding.`,
    })

    // Call (potOdds already defined above)
    const callQuality: Quality =
      villainStrong && hs && hs.str >= 3 ? 'best' :
      villainStrong && hs && hs.str === 2 ? 'good' :
      villainStrong && hs && hs.str <= 1 ? 'bad' :
      villainWeak && hs && hs.str >= 1 ? 'best' :
      villainWeak && hs && (hs.heroFD || hs.oesd) ? 'good' :
      hs && hs.str >= 2 ? 'best' :
      hs && (hs.heroFD || hs.oesd) && potOdds < 0.33 ? 'best' :
      hs && hs.str === 1 && hs.pairPos === 'toppair' ? 'best' :
      hs && hs.str === 1 ? 'ok' : 'bad'
    const pfCallCost = Math.min(heroSeat.stack, currentBet)
    const pfCallIsAllIn = pfCallCost >= heroSeat.stack
    options.push({
      label: pfCallIsAllIn ? `Call All-In ${pfCallCost.toLocaleString()}` : `Call ${currentBet.toLocaleString()}`,
      type: pfCallIsAllIn ? 'shove' : 'call',
      amount: pfCallCost,
      chipCost: pfCallCost,
      quality: callQuality,
      coaching: callQuality === 'best'
        ? `Good call. ${hs?.label || 'Your hand'} has the equity to continue.${villainContext}`
        : callQuality === 'ok'
        ? `Marginal call. You're getting reasonable odds but the hand is weak.${villainContext}`
        : `Calling here with ${hs?.label || 'this hand'} is a chip leak. Fold or raise.${villainContext}`,
    })

    // Raise / Re-raise
    const raiseSize = Math.round(currentBet * 2.5 / 100) * 100
    const raiseQuality: Quality = hs && hs.str >= 3 ? 'best' :
      hs && (hs.heroFD && hs.oesd) ? 'best' : // combo draw semi-bluff
      hs && hs.str === 2 ? 'good' :
      hs && (hs.heroFD || hs.oesd) ? 'ok' : 'bad'
    if (raiseSize < heroSeat.stack * 0.8) {
      options.push({
        label: `Raise to ${raiseSize.toLocaleString()}`,
        type: 'raise',
        amount: raiseSize,
        chipCost: raiseSize,
        quality: raiseQuality,
        coaching: raiseQuality === 'best'
          ? `Strong raise. ${hs?.label || 'Your hand'} — build the pot and apply pressure.`
          : raiseQuality === 'good'
          ? `Good semi-bluff raise. Two ways to win — fold equity now or improving.`
          : raiseQuality === 'ok'
          ? `Marginal raise. You have some equity but calling is safer.`
          : `Raising here without equity is a bluff. Check your hand strength.`,
      })
    }

    // Shove
    const shoveQuality: Quality =
      committed ? 'best' :
      (hs && hs.str >= 4) ? 'best' :
      (hs && hs.str === 2 && !boardHasDangerCard) ? 'good' :
      (hs && hs.str === 1 && hs.pairPos === 'overpair' && boardHasDangerCard) ? 'bad' :
      (hs && hs.str >= 2 && spr < 4) ? 'good' :
      (hs && (hs.heroFD && hs.oesd) && spr < 6) ? 'good' :
      'bad'
    options.push({
      label: `Shove ${heroSeat.stack.toLocaleString()}`,
      type: 'shove',
      amount: heroSeat.stack,
      chipCost: heroSeat.stack,
      quality: shoveQuality,
      coaching: shoveQuality === 'best'
        ? `Correct shove. SPR is ${spr} — you're committed with ${hs?.label || 'this hand'}.`
        : shoveQuality === 'good'
        ? `Aggressive but reasonable. SPR is low enough to justify the shove.`
        : `Too much risk. Your hand doesn't warrant an all-in at this stack depth.`,
    })

    return options
  }

  // No bet facing — check or bet
  const activePlayers = activeSeats?.filter(s => !s.folded).length ?? 2
  const multiwayAdj = activePlayers >= 4 ? 1.20 :
                      activePlayers === 3 ? 1.10 : 1.0
  // Check
  const checkQuality: Quality =
    villainRaisedLastStreet ? 'best' :
    (villainStrong && hs && hs.str < 3) ? 'best' :
    (villainStrong && hs && hs.str >= 5) ? 'ok' :
    (heroDonking && hs && hs.str < 2 && !hs.heroFD && !hs.oesd) ? 'best' :
    (hs && hs.str === 0 && !hs.heroFD && !hs.oesd) ? 'best' :
    (hs && hs.str >= 2 && street === 'river' && !villainRaisedLastStreet && !villainStrong) ? 'bad' :
    (activePlayers >= 4 && hs && hs.str === 1 &&
      hs.pairPos !== 'toppair' && hs.pairPos !== 'overpair') ? 'good' :
    (villainWeak && hs && hs.str >= 1) ? 'ok' :
    'ok'
  options.push({
    label: 'Check',
    type: 'check',
    amount: 0,
    chipCost: 0,
    quality: checkQuality,
    coaching: checkQuality === 'best'
      ? (villainRaisedLastStreet
        ? `Check and re-evaluate — villain showed aggression last street.${villainContext}`
        : heroDonking && hs && hs.str < 2
        ? `Check here — don't donk bet weak hands into the preflop raiser. Let them c-bet and react with your hand strength.`
        : `High card has little equity. Check and see a free card.`)
      : checkQuality === 'bad'
      ? `Never slowplay ${hs?.label ?? 'this hand'} on the river. Bet for value — checking gives free showdowns.${villainContext}`
      : heroDonking
      ? `Checking is preferred OOP. You can lead the river when you have a clear value hand.`
      : `Checking is fine for pot control.${nearBubble ? ' Near the bubble, pot control is especially important.' : ' Be ready to call a reasonable bet.'}${priorBetDesc}${villainContext}`,
  })

  // Turn and river bets scale up: narrower range = larger sizing
  const streetSizeAdj = street === 'river' ? 1.20 :
                        street === 'turn'  ? 1.12 : 1.0

  // Bet small
  const rawBetSm  = Math.round(pot * texStrat.cBetSizing * 0.70 * multiwayAdj * streetSizeAdj / 100) * 100
  const rawBetMed = Math.round(pot * texStrat.cBetSizing        * multiwayAdj * streetSizeAdj / 100) * 100
  const rawBetLg  = Math.round(pot * texStrat.cBetSizing * 1.35 * multiwayAdj * streetSizeAdj / 100) * 100

  const betSm  = Math.min(heroSeat.stack, Math.max(100, rawBetSm))
  const betMed = Math.min(heroSeat.stack, Math.max(100, rawBetMed))
  const betLg  = Math.min(heroSeat.stack, Math.max(100, rawBetLg))

  const skipBetMed = betMed >= heroSeat.stack * 0.9
  const skipBetSm  = betSm  >= heroSeat.stack * 0.9

  const betQuality = (hs: HandResult | null, sizing: 'sm' | 'med' | 'lg'): Quality => {
    if (!hs) return 'ok'
    if (villainStrong) {
      if (hs.str >= 5) return 'best'
      if (hs.str === 4) return 'best'
      if (hs.str === 3) return 'good'
      if (hs.str === 2) return 'ok'
      return 'bad'
    }
    if (villainWeak) {
      if (hs.str >= 2) return 'best'
      if (hs.str === 1) return 'good'
      if (hs.str === 0 && heroRaisedPreflop && isDry) return 'ok'
      if (hs.str === 0 && (hs.heroFD || hs.oesd)) return 'ok'
      if (hs.str === 0) return 'ok'
      return 'bad'
    }
    // Medium villain — standard logic
    if (heroDonking) {
      if (hs.str >= 3) return 'good'
      if (hs.str === 2) return 'ok'
      if (hs.heroFD && hs.oesd) return 'ok'
      return 'bad'
    }
    if (villainRaisedLastStreet) {
      if (hs.str >= 4) return 'good'
      if (hs.str === 3) return 'ok'
      return 'bad'
    }
    if (hs.str >= 5) return 'best'
    if (hs.str === 4) return sizing === 'sm' ? 'good' : 'best'
    if (hs.str === 3) return sizing === 'lg' ? 'ok' : 'best'
    if (hs.str === 2) return sizing === 'med' ? 'best' : 'good'
    if (hs.str === 1 && (hs.pairPos === 'toppair' || hs.pairPos === 'overpair')) {
      return 'best'
    }
    if (hs.str === 1) return sizing === 'sm' ? 'ok' : 'bad'
    if (hs.str === 0 && heroRaisedPreflop && isDry && (hs.overcards ?? 0) >= 1) return 'ok'
    if (hs.str === 0 && (hs.heroFD || hs.oesd)) return sizing === 'sm' ? 'ok' : 'bad'
    return 'bad'
  }

  if (!skipBetSm) {
    options.push({
      label: `Bet ${betSm.toLocaleString()} (small)`,
      type: 'raise',
      amount: betSm,
      chipCost: betSm,
      quality: betQuality(hs, 'sm'),
      coaching: heroDonking && betQuality(hs, 'sm') === 'bad'
        ? `Avoid donk betting ${hs?.label ?? 'this hand'} into the preflop raiser. Check and let them bet — you can check-raise strong hands or check-call with draws.`
        : `Small bet on ${texStrat.label} board. ${texStrat.note}${villainContext}`,
    })
  }

  if (!skipBetMed) {
    options.push({
      label: `Bet ${betMed.toLocaleString()} (${Math.round(texStrat.cBetSizing * 100)}% pot)`,
      type: 'raise',
      amount: betMed,
      chipCost: betMed,
      quality: betQuality(hs, 'med'),
      coaching: `Standard sizing. ${texStrat.note}${nearBubbleNote}${villainContext}`,
    })
  }

  if (!skipBetMed) {
    options.push({
      label: `Bet ${betLg.toLocaleString()} (large)`,
      type: 'raise',
      amount: betLg,
      chipCost: betLg,
      quality: betQuality(hs, 'lg'),
      coaching: `Large bet. Use this with strong hands that want to build the pot or strong draws charging a price.${villainContext}`,
    })
  }

  // Shove option (when committed or short)
  if (spr < 4 || depth < 20) {
    const shoveQ: Quality =
      (hs && hs.str >= 3) ? 'best' :
      (hs && hs.str === 1 && hs.pairPos === 'overpair' && boardHasDangerCard) ? 'bad' :
      (hs && hs.str >= 1 && spr < 2) ? 'good' :
      'bad'
    options.push({
      label: `Shove ${heroSeat.stack.toLocaleString()}`,
      type: 'shove',
      amount: heroSeat.stack,
      chipCost: heroSeat.stack,
      quality: shoveQ,
      coaching: shoveQ === 'best'
        ? `Shove for max value. SPR is ${spr} — you're committed.`
        : `Marginal shove. Consider the SPR and your hand strength carefully.`,
    })
  }

  return options
}

// ─────────────────────────────────────────────────────────────
// BOARD TEXTURE CLASSIFIER
// ─────────────────────────────────────────────────────────────

function classifyBoardTexture(board: Card[]): keyof typeof BOARD_TEXTURE {
  if (board.length < 3) return 'dry'
  const suits = board.slice(0, 3).map(c => c.s)
  const RANK_VAL: Record<string, number> = {
    'A':14,'K':13,'Q':12,'J':11,'T':10,
    '9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2,
  }
  const vals = board.slice(0, 3).map(c => RANK_VAL[c.r]).sort((a,b) => b-a)
  const uniqueSuits = new Set(suits).size
  const rankRange = vals[0] - vals[2]
  const uniqueRanks = new Set(board.slice(0,3).map(c=>c.r)).size

  if (uniqueSuits === 1) return 'monotone'
  if (uniqueRanks < 3) return 'paired'
  if (rankRange <= 4) return 'connected'
  if (uniqueSuits === 2 && rankRange <= 6) return 'wet'
  return 'dry'
}

// ─────────────────────────────────────────────────────────────
// MAIN HAND ENGINE
// Returns the first HeroDecision — subsequent decisions are
// generated by processHeroAction()
// ─────────────────────────────────────────────────────────────

export interface HandEngine {
  // Current state
  seats:          Seat[]
  heroSeat:       Seat
  deck:           Card[]
  board:          Card[]
  pot:            number
  street:         Street
  activeSeats:    Seat[]
  streetLog:      string[]      // narrative lines per street
  handLog:        StreetResult[]
  usedCards:      Set<string>

  // Next decision for hero
  currentDecision: HeroDecision | null

  // Pending street advance (villains responded, waiting for user to deal next card)
  pendingAdvance:    boolean
  pendingStreetDesc: string

  // Villain tracking
  villainProfiles:  VillainProfile[]
  primaryVillain:   VillainProfile | null

  // Terminal state
  isOver:         boolean
  heroWon:        boolean
  isTie:          boolean
  showdownSeat:   Seat | null
}

export function createHand(
  seats: Seat[],
  heroSeatIndex: number,
  levelIndex: number,
  playersLeft: number,
): HandEngine {
  const deck = shuffleDeck(buildDeck())
  const usedCards = new Set<string>()

  // Deal hero cards first (from actual deck)
  const heroCards = dealRandomHand(deck, usedCards)
  const updatedSeats = seats.map((s, i) => ({
    ...s,
    holeCards: i === heroSeatIndex ? heroCards : null,
    folded: false,
    allIn: false,
    invested: 0,
  }))

  const bb = getBB(levelIndex)
  const sb = getSB(levelIndex)
  const ante = getAnte(levelIndex)

  // Post blinds and ante
  // BB ante format: BB pays both the ante and the big blind
  // The ante is dead money — only the blind counts toward facing a raise
  const sbSeat = updatedSeats.find(s => s.position === 'SB')!
  const bbSeat = updatedSeats.find(s => s.position === 'BB')!
  sbSeat.stack -= sb
  sbSeat.invested = sb
  bbSeat.stack -= bb + ante
  bbSeat.invested = bb  // Only the blind counts toward facing a raise — ante is dead money

  const startingPot = sb + bb + ante

  const engine: HandEngine = {
    seats: updatedSeats,
    heroSeat: updatedSeats[heroSeatIndex],
    deck,
    board: [],
    pot: startingPot,
    street: 'preflop',
    activeSeats: [...updatedSeats],
    streetLog: [],
    handLog: [],
    usedCards,
    currentDecision: null,
    pendingAdvance: false,
    pendingStreetDesc: '',
    villainProfiles: [],
    primaryVillain: null,
    isOver: false,
    heroWon: false,
    isTie: false,
    showdownSeat: null,
  }

  // Initialize villain profiles for all non-hero seats
  engine.villainProfiles = updatedSeats
    .filter(s => s.seatIndex !== heroSeatIndex)
    .map(s => ({
      seatIndex:      s.seatIndex,
      position:       s.position,
      actionSequence: [],
      rangeStrength:  5,
      rangeNarrow:    'Preflop range unknown',
      isPrimary:      false,
    }))

  // Deal all villain hands upfront from shuffled remaining deck
  for (const seat of updatedSeats) {
    if (seat.seatIndex === heroSeatIndex) continue
    const c1 = engine.deck.shift()
    const c2 = engine.deck.shift()
    if (c1 && c2) {
      seat.holeCards = [c1, c2]
      engine.usedCards.add(c1.r + c1.s)
      engine.usedCards.add(c2.r + c2.s)
    }
  }

  // Run preflop action until hero's turn
  engine.currentDecision = runPreflopToHero(engine, levelIndex, playersLeft)
  return engine
}

function runPreflopToHero(
  engine: HandEngine,
  levelIndex: number,
  playersLeft: number,
): HeroDecision {
  const bb = getBB(levelIndex)
  const sb = getSB(levelIndex)
  const heroPos = engine.heroSeat.position
  let currentBet = bb
  let raisers = 0
  let limpers = 0
  const actionLines: string[] = []
  let lastAggressorSeat: Seat | null = null

  // Action order: UTG → SB, then BB acts last
  for (const pos of PREFLOP_ORDER) {
    if (pos === heroPos) break // stop when we reach hero

    const seat = engine.seats.find(s => s.position === pos)
    if (!seat || seat.folded) continue

    const result = resolveVillainPreflop(
      seat, levelIndex, currentBet, engine.pot, limpers, raisers, bb
    )

    const pProfile = engine.villainProfiles.find(p => p.seatIndex === seat.seatIndex)
    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
      if (pProfile) {
        pProfile.actionSequence = ['fold']
        const sc = scoreSequence(pProfile.actionSequence)
        pProfile.rangeStrength = sc.strength
        pProfile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'limp') {
      const cost = bb - seat.invested
      seat.stack -= cost
      seat.invested += cost
      engine.pot += cost
      limpers++
      actionLines.push(result.desc)
      if (pProfile) {
        pProfile.actionSequence = ['limp']
        const sc = scoreSequence(pProfile.actionSequence)
        pProfile.rangeStrength = sc.strength
        pProfile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'raise' || result.action.type === 'shove') {
      const amount = result.action.amount
      const cost = amount - seat.invested
      seat.stack -= Math.min(cost, seat.stack)
      seat.invested = Math.min(seat.invested + cost, seat.invested + seat.stack + cost)
      engine.pot += Math.min(cost, seat.stack + cost)
      currentBet = amount
      raisers++
      lastAggressorSeat = seat
      actionLines.push(result.desc)
      if (pProfile) {
        const pfCode = result.action.type === 'shove' ? 'shove' :
          raisers === 1 ? 'rfi' : raisers === 2 ? '3bet' : '4bet'
        pProfile.actionSequence = [pfCode]
        const sc = scoreSequence(pProfile.actionSequence)
        pProfile.rangeStrength = sc.strength
        pProfile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'call') {
      const cost = currentBet - seat.invested
      seat.stack -= cost
      seat.invested += cost
      engine.pot += cost
      limpers++
      actionLines.push(result.desc)
      if (pProfile) {
        pProfile.actionSequence = [raisers > 0 ? 'call' : 'limp']
        const sc = scoreSequence(pProfile.actionSequence)
        pProfile.rangeStrength = sc.strength
        pProfile.rangeNarrow   = sc.description
      }
    }
  }
  updatePrimaryVillain(engine)

  // Continue action after hero (BB, or remaining players if hero is early)
  // This is simplified — remaining villains after hero will be resolved in processHeroAction

  // Short stack warnings
  const shortStackNotes: string[] = []
  for (const seat of engine.seats) {
    if (seat.seatIndex === engine.heroSeat.seatIndex) continue
    if (seat.folded) continue
    const seatDepth = getBBDepth(seat.stack, levelIndex)
    if (seatDepth > 0 && seatDepth < 15) {
      shortStackNotes.push(`${seat.position} is short (${seatDepth}BB)`)
    }
  }
  const shortStackNote = shortStackNotes.length > 0
    ? ` Note: ${shortStackNotes.join(', ')}.` : ''

  const desc = actionLines.length > 0
    ? actionLines.join('. ') + `. Action on you in ${heroPos}.` + shortStackNote
    : `Action on you in ${heroPos}.` + shortStackNote

  return {
    street: 'preflop',
    board: [],
    pot: engine.pot,
    heroStack: engine.heroSeat.stack,
    heroPos,
    heroCards: engine.heroSeat.holeCards!,
    desc,
    options: generateHeroOptions(
      engine.heroSeat,
      [],
      engine.pot,
      currentBet > bb ? currentBet : 0,
      'preflop',
      levelIndex,
      playersLeft,
      lastAggressorSeat,
      raisers,
      limpers,
      engine.activeSeats,
      [],
      engine.primaryVillain?.rangeStrength,
      engine.primaryVillain?.rangeNarrow,
    ),
    activePlayers: engine.activeSeats.length,
    lastAggressor: lastAggressorSeat,
  }
}

// ─────────────────────────────────────────────────────────────
// PROCESS HERO ACTION
// Called after hero makes a decision. Returns next HeroDecision
// or null if hand is over.
// ─────────────────────────────────────────────────────────────

export function processHeroAction(
  engine: HandEngine,
  heroOption: HeroOption,
  levelIndex: number,
  playersLeft: number,
): HeroDecision | null {
  const heroSeat = engine.heroSeat
  const bb = getBB(levelIndex)

  // Apply hero's action to chip state
  if (heroOption.type === 'fold') {
    heroSeat.folded = true
    engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== heroSeat.seatIndex)
    engine.isOver = true
    engine.heroWon = false
    engine.handLog.push({
      street: engine.street,
      board: [...engine.board],
      heroAction: heroOption,
      pot: engine.pot,
      desc: engine.currentDecision?.desc ?? '',
    })
    return null
  }

  // Hero calls, raises, checks, bets, or shoves
  const cost = heroOption.chipCost
  heroSeat.stack -= cost
  heroSeat.invested += cost
  engine.pot += cost

  if (heroOption.type === 'shove') heroSeat.allIn = true

  engine.handLog.push({
    street: engine.street,
    board: [...engine.board],
    heroAction: heroOption,
    pot: engine.pot,
    desc: engine.currentDecision?.desc ?? '',
  })

  // Inline villain resolution on this street
  const actionLines: string[] = []
  let currentBet = heroOption.amount
  let lastAggressorSeat: Seat | null = null
  let raisedAfterHero = false

  const order = engine.street === 'preflop' ? PREFLOP_ORDER : POSTFLOP_ORDER
  const heroIdx = order.indexOf(heroSeat.position)

  const heroRaised = heroOption.type === 'raise' || heroOption.type === 'shove'
  const remainingOrder = (
    heroRaised
      ? [...order.slice(heroIdx + 1), ...order.slice(0, heroIdx)]
      : order.slice(heroIdx + 1)
  ).filter(pos => {
    const seat = engine.seats.find(s => s.position === pos)
    return seat && !seat.folded && !seat.allIn && seat.seatIndex !== heroSeat.seatIndex
  })

  for (const pos of remainingOrder) {
    const seat = engine.seats.find(s => s.position === pos)
    if (!seat || seat.folded || seat.allIn) continue

    let result: { action: PlayerAction; desc: string }

    if (engine.street === 'preflop') {
      const heroIs3bet = heroOption.label.toLowerCase().includes('3-bet') ||
        heroOption.label.toLowerCase().includes('3bet')
      const heroIsRaising = heroOption.type === 'raise' || heroOption.type === 'shove'
      const raisersCount = heroIsRaising ? (heroIs3bet ? 2 : 1) : 0
      const pfResult = resolveVillainPreflop(
        seat, levelIndex, currentBet, engine.pot, 0,
        raisersCount, bb
      )
      result = { action: pfResult.action, desc: pfResult.desc }
    } else {
      result = resolveVillainPostflop(
        seat, engine.board, engine.pot,
        currentBet, engine.street, levelIndex,
        lastAggressorSeat?.seatIndex === seat.seatIndex
      )
    }

    const vprofile = engine.villainProfiles.find(p => p.seatIndex === seat.seatIndex)
    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
      if (vprofile) {
        const prevLast = vprofile.actionSequence[vprofile.actionSequence.length - 1]
        const foldCode = prevLast === 'x' ? 'xf' : 'f'
        vprofile.actionSequence.push(foldCode)
        const sc = scoreSequence(vprofile.actionSequence)
        vprofile.rangeStrength = sc.strength
        vprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'call' || result.action.type === 'limp') {
      const callCost = Math.min(seat.stack, currentBet - seat.invested)
      seat.stack -= callCost
      seat.invested += callCost
      engine.pot += callCost
      if (seat.stack === 0) seat.allIn = true
      actionLines.push(result.desc)
      if (vprofile) {
        if (engine.street === 'preflop') {
          vprofile.actionSequence = [raisedAfterHero ? 'call' : 'limp']
        } else {
          const last = vprofile.actionSequence[vprofile.actionSequence.length - 1]
          if (last === 'x') vprofile.actionSequence[vprofile.actionSequence.length - 1] = 'xc'
          else vprofile.actionSequence.push('c')
        }
        const sc = scoreSequence(vprofile.actionSequence)
        vprofile.rangeStrength = sc.strength
        vprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'raise' || result.action.type === 'shove') {
      const raiseAmt = result.action.amount
      const raiseCost = raiseAmt - seat.invested
      seat.stack -= raiseCost
      seat.invested += raiseCost
      engine.pot += raiseCost
      currentBet = raiseAmt
      lastAggressorSeat = seat
      raisedAfterHero = true
      if (result.action.type === 'shove') seat.allIn = true
      actionLines.push(result.desc)
      if (vprofile) {
        if (engine.street === 'preflop') {
          const heroIsRaiser = heroOption.type === 'raise' || heroOption.type === 'shove'
          vprofile.actionSequence = [heroIsRaiser ? '3bet' : 'rfi']
        } else {
          const last = vprofile.actionSequence[vprofile.actionSequence.length - 1]
          if (last === 'x') vprofile.actionSequence[vprofile.actionSequence.length - 1] = 'xr'
          else vprofile.actionSequence.push('r')
        }
        const sc = scoreSequence(vprofile.actionSequence)
        vprofile.rangeStrength = sc.strength
        vprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'check') {
      actionLines.push(result.desc)
      if (vprofile && engine.street !== 'preflop') {
        vprofile.actionSequence.push('x')
        const sc = scoreSequence(vprofile.actionSequence)
        vprofile.rangeStrength = sc.strength
        vprofile.rangeNarrow   = sc.description
      }
    }
  }
  updatePrimaryVillain(engine)

  // Villain re-raised — hero must act again on same street
  if (raisedAfterHero && lastAggressorSeat) {
    const desc = actionLines.join('. ') + `. Action back on you in ${heroSeat.position}.`
    return {
      street: engine.street,
      board: [...engine.board],
      pot: engine.pot,
      heroStack: heroSeat.stack,
      heroPos: heroSeat.position,
      heroCards: heroSeat.holeCards!,
      desc,
      options: generateHeroOptions(
        heroSeat, engine.board, engine.pot,
        currentBet, engine.street, levelIndex,
        playersLeft, lastAggressorSeat,
        1, 0,
        engine.activeSeats,
        engine.handLog.map(l => ({ street: l.street, heroAction: l.heroAction.label, pot: l.pot })),
        engine.primaryVillain?.rangeStrength,
        engine.primaryVillain?.rangeNarrow,
      ),
      activePlayers: engine.activeSeats.filter(s => !s.folded).length,
      lastAggressor: lastAggressorSeat,
    }
  }

  // Only one player remains — hand over
  const stillIn = engine.activeSeats.filter(s => !s.folded)
  if (stillIn.length === 1) {
    engine.pendingStreetDesc = actionLines.length > 0 ? actionLines.join('. ') : ''
    engine.isOver = true
    engine.heroWon = stillIn[0].seatIndex === heroSeat.seatIndex
    if (!engine.heroWon) engine.showdownSeat = stillIn[0]
    return null
  }

  // All-in runout or river showdown — advance immediately (no pause)
  const canAct = stillIn.filter(s => !s.allIn)
  if (canAct.length <= 1 || engine.street === 'river') {
    return advanceStreet(engine, actionLines, levelIndex, playersLeft)
  }

  // Street done, hand continues — pause for user to click to deal next card
  engine.pendingAdvance = true
  engine.pendingStreetDesc = actionLines.length > 0 ? actionLines.join('. ') : ''
  engine.currentDecision = null
  return null
}

export function advanceToNextStreet(
  engine: HandEngine,
  levelIndex: number,
  playersLeft: number,
): HeroDecision | null {
  engine.pendingAdvance = false
  engine.pendingStreetDesc = ''
  return advanceStreet(engine, [], levelIndex, playersLeft)
}

function advanceStreet(
  engine: HandEngine,
  foldLines: string[],
  levelIndex: number,
  playersLeft: number,
): HeroDecision | null {
  const stillIn = engine.activeSeats.filter(s => !s.folded)

  if (stillIn.length <= 1) {
    engine.isOver = true
    engine.heroWon = stillIn[0]?.seatIndex === engine.heroSeat.seatIndex
    return null
  }

  // Deal next street
  if (engine.street === 'preflop') {
    engine.board = burnAndDeal(engine.deck, 3)
    engine.street = 'flop'
  } else if (engine.street === 'flop') {
    engine.board = [...engine.board, ...burnAndDeal(engine.deck, 1)]
    engine.street = 'turn'
  } else if (engine.street === 'turn') {
    engine.board = [...engine.board, ...burnAndDeal(engine.deck, 1)]
    engine.street = 'river'
  } else if (engine.street === 'river') {
    // Hand over — showdown
    engine.isOver = true
    let heroWon = true
    let showdownSeat: Seat | null = null
    let tieCount = 0
    for (const seat of stillIn) {
      if (seat.seatIndex === engine.heroSeat.seatIndex) continue
      if (seat.holeCards) {
        const result = compareHands(
          engine.heroSeat.holeCards![0], engine.heroSeat.holeCards![1],
          seat.holeCards[0], seat.holeCards[1],
          engine.board
        )
        if (result.tie) { tieCount++ }
        else if (!result.heroWins) { heroWon = false; showdownSeat = seat }
      }
    }
    if (!heroWon && tieCount > 0 && showdownSeat === null) {
      engine.heroWon = true
      engine.isTie = true
      engine.showdownSeat = stillIn.find(s => s.seatIndex !== engine.heroSeat.seatIndex) ?? null
    } else {
      engine.heroWon = heroWon
      engine.showdownSeat = showdownSeat ?? stillIn.find(s => s.seatIndex !== engine.heroSeat.seatIndex) ?? null
    }
    return null
  }

  // Reset invested for new street
  stillIn.forEach(s => { s.invested = 0 })

  // If hero is all-in, run out remaining streets automatically
  if (engine.heroSeat.allIn) {
    while (engine.street !== 'river') {
      if (engine.street === 'flop') {
        engine.board = [...engine.board, ...burnAndDeal(engine.deck, 1)]
        engine.street = 'turn'
      } else if (engine.street === 'turn') {
        engine.board = [...engine.board, ...burnAndDeal(engine.deck, 1)]
        engine.street = 'river'
      } else {
        break
      }
    }
    const boardDesc = engine.board.map(c => c.r + c.s).join(' ')
    engine.pendingStreetDesc = `Board runs out: ${boardDesc}.`
    engine.isOver = true
    let heroWon = true
    let showdownSeat: Seat | null = null
    let tieCount = 0
    for (const seat of stillIn) {
      if (seat.seatIndex === engine.heroSeat.seatIndex) continue
      if (seat.holeCards) {
        const result = compareHands(
          engine.heroSeat.holeCards![0], engine.heroSeat.holeCards![1],
          seat.holeCards[0], seat.holeCards[1],
          engine.board
        )
        if (result.tie) { tieCount++ }
        else if (!result.heroWins) { heroWon = false; showdownSeat = seat }
      }
    }
    if (!heroWon && tieCount > 0 && showdownSeat === null) {
      engine.heroWon = true
      engine.isTie = true
      engine.showdownSeat = stillIn.find(s => s.seatIndex !== engine.heroSeat.seatIndex) ?? null
    } else {
      engine.heroWon = heroWon
      engine.showdownSeat = showdownSeat
        ?? stillIn.find(s => s.seatIndex !== engine.heroSeat.seatIndex)
        ?? null
    }
    return null
  }

  // Build fold notes for description
  const foldNote = foldLines.length > 0 ? foldLines.join('. ') + '. ' : ''

  // Determine first to act postflop (first active player left of dealer/BTN)
  const postflopOrder = POSTFLOP_ORDER.filter(pos => {
    const seat = engine.seats.find(s => s.position === pos)
    return seat && !seat.folded
  })

  // Run villain actions before hero on this street
  const heroPos = engine.heroSeat.position
  const heroIdx = postflopOrder.indexOf(heroPos)
  const actBeforeHero = postflopOrder.slice(0, heroIdx)
  const actionLines: string[] = []
  let currentBet = 0
  let lastAggressorSeat: Seat | null = null

  for (const pos of actBeforeHero) {
    const seat = engine.seats.find(s => s.position === pos)
    if (!seat || seat.folded || seat.allIn) continue

    const result = resolveVillainPostflop(
      seat, engine.board, engine.pot,
      currentBet, engine.street, levelIndex, false
    )

    const avprofile = engine.villainProfiles.find(p => p.seatIndex === seat.seatIndex)
    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
      if (avprofile) {
        const prevLast = avprofile.actionSequence[avprofile.actionSequence.length - 1]
        avprofile.actionSequence.push(prevLast === 'x' ? 'xf' : 'f')
        const sc = scoreSequence(avprofile.actionSequence)
        avprofile.rangeStrength = sc.strength
        avprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'check') {
      actionLines.push(result.desc)
      if (avprofile) {
        avprofile.actionSequence.push('x')
        const sc = scoreSequence(avprofile.actionSequence)
        avprofile.rangeStrength = sc.strength
        avprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'raise') {
      const betCost = result.action.amount
      seat.stack -= betCost
      seat.invested += betCost
      engine.pot += betCost
      currentBet = betCost
      lastAggressorSeat = seat
      actionLines.push(result.desc)
      if (avprofile) {
        avprofile.actionSequence.push('b')
        const sc = scoreSequence(avprofile.actionSequence)
        avprofile.rangeStrength = sc.strength
        avprofile.rangeNarrow   = sc.description
      }
    } else if (result.action.type === 'call') {
      const callCost = result.action.amount
      seat.stack -= callCost
      seat.invested += callCost
      engine.pot += callCost
      actionLines.push(result.desc)
      if (avprofile) {
        avprofile.actionSequence.push('c')
        const sc = scoreSequence(avprofile.actionSequence)
        avprofile.rangeStrength = sc.strength
        avprofile.rangeNarrow   = sc.description
      }
    }
  }
  updatePrimaryVillain(engine)

  // Check if everyone folded before hero
  const stillActive = engine.activeSeats.filter(s => !s.folded)
  if (stillActive.length === 1 && stillActive[0].seatIndex === engine.heroSeat.seatIndex) {
    engine.isOver = true
    engine.heroWon = true
    return null
  }

  const boardStr = engine.board.map(c => c.r + c.s).join(' ')
  const postflopShortNotes: string[] = []
  for (const seat of engine.seats) {
    if (seat.seatIndex === engine.heroSeat.seatIndex || seat.folded) continue
    const sd = getBBDepth(seat.stack, levelIndex)
    if (sd > 0 && sd < 15) postflopShortNotes.push(`${seat.position} short (${sd}BB)`)
  }
  const postflopShortNote = postflopShortNotes.length > 0
    ? ` [${postflopShortNotes.join(', ')}]` : ''
  const desc = `${foldNote}${actionLines.length > 0 ? actionLines.join('. ') + '. ' : ''}Action on you in ${heroPos}. Board: ${boardStr}${postflopShortNote}`

  return {
    street: engine.street,
    board: [...engine.board],
    pot: engine.pot,
    heroStack: engine.heroSeat.stack,
    heroPos,
    heroCards: engine.heroSeat.holeCards!,
    desc,
    options: generateHeroOptions(
      engine.heroSeat,
      engine.board,
      engine.pot,
      currentBet,
      engine.street,
      levelIndex,
      playersLeft,
      lastAggressorSeat,
      0,
      0,
      engine.activeSeats,
      engine.handLog.map(l => ({ street: l.street, heroAction: l.heroAction.label, pot: l.pot })),
      engine.primaryVillain?.rangeStrength,
      engine.primaryVillain?.rangeNarrow,
    ),
    activePlayers: stillActive.length,
    lastAggressor: lastAggressorSeat,
  }
}

// ─────────────────────────────────────────────────────────────
// TABLE SETUP
// ─────────────────────────────────────────────────────────────

const ARCHETYPE_POOL: Archetype[] = ['LP', 'LP', 'LP', 'LA', 'LA', 'TA', 'TA', 'TP']

export function createTable(heroStack: number): Omit<Seat, 'position'>[] {
  return Array.from({ length: 9 }, (_, i) => ({
    seatIndex: i,
    name: i === 4 ? 'YOU' : VILLAIN_NAMES[i],
    stack: STARTING_STACK,
    archetype: i === 4 ? 'TA' : ARCHETYPE_POOL[Math.floor(Math.random() * ARCHETYPE_POOL.length)],
    holeCards: null,
    folded: false,
    allIn: false,
    invested: 0,
  }))
}

export function assignPositions(
  tableSeats: Omit<Seat, 'position'>[],
  dealerButtonIndex: number  // seat index of BTN
): Seat[] {
  // Positions assigned clockwise from BTN
  const posOrder: Position[] = ['BTN', 'SB', 'BB', 'UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO']
  return tableSeats.map((seat, i) => {
    const offset = (i - dealerButtonIndex + 9) % 9
    return { ...seat, position: posOrder[offset] }
  })
}

export function getHeroPosition(
  seats: Seat[],
  heroSeatIndex: number
): Position {
  return seats[heroSeatIndex].position
}
