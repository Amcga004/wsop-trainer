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
): HeroOption[] {
  const bb = getBB(levelIndex)
  const sb = getSB(levelIndex)
  const depth = getBBDepth(heroSeat.stack, levelIndex)
  const ranges = getRanges(heroSeat.position, depth)
  const nearBubble = isNearBubble(playersLeft)
  const isNearFinalTable = playersLeft <= 27
  const isDeepMoney = playersLeft <= 500
  const icmPressure = isNearFinalTable ? 1.4 : nearBubble ? 1.2 : isDeepMoney ? 0.9 : 1.0
  const options: HeroOption[] = []
  const heroHandStr = heroSeat.holeCards
    ? cardToHandStr(heroSeat.holeCards[0], heroSeat.holeCards[1])
    : ''
  const fmtChips = (n: number) => n.toLocaleString()

  // ── PREFLOP ──────────────────────────────────────────────
  if (street === 'preflop') {
    const inRFI = ranges.rfi.includes(heroHandStr)
    const inCall = ranges.vsRaiseCall.includes(heroHandStr)
    const in3bet = ranges.threebet.includes(heroHandStr)
    const inVs3betCall = ranges.vs3betCall.includes(heroHandStr)
    const in4bet = ranges.fourbet.includes(heroHandStr)
    const shoveRanges = depth < 20 ? getShoveRanges(heroSeat.position, depth) : null
    const inShove = shoveRanges ? shoveRanges.shove.includes(heroHandStr) : false

    // 4-bet continuation range: fourbet range + QQ+/AK as floor
    const in4betContinue = ranges.fourbet.includes(heroHandStr) ||
      ['AA','KK','QQ','AKs','AKo'].some(h => heroHandStr.startsWith(h.slice(0, 2)))

    // Squeeze situation: one raiser + callers = dead money hero can pick up with a 3-bet
    const isSqueeze = raisers === 1 && limpers >= 1
    const squeezeDeadMoney = limpers * currentBet

    // Fold
    const foldCallCost = currentBet > 0 ? Math.min(heroSeat.stack, Math.max(0, currentBet - heroSeat.invested)) : 0
    const foldPotOdds = foldCallCost > 0 ? foldCallCost / (pot + foldCallCost) : 1
    const foldQuality: Quality =
      (raisers >= 3 && in4betContinue) ? 'bad' :
      (raisers >= 3) ? 'best' :
      (raisers === 2 && inVs3betCall) ? 'bad' :
      (raisers === 2) ? 'best' :
      (raisers === 1 && inCall) ? 'bad' :
      (raisers === 0 && inRFI) ? 'bad' :
      (foldCallCost > 0 && foldPotOdds < 0.15) ? 'ok' :
      'best'
    options.push({
      label: 'Fold',
      type: 'fold',
      amount: 0,
      chipCost: 0,
      quality: foldQuality,
      coaching: foldQuality === 'best'
        ? raisers >= 3
          ? `Correct fold. Facing a 4-bet, continue only with QQ+/AK. ${heroHandStr} is too weak to continue.`
          : isSqueeze && (inRFI || inCall)
          ? `Folding here gives up a squeeze opportunity. ${heroHandStr} in a squeeze spot with ${limpers} dead caller${limpers > 1 ? 's' : ''} could be a profitable 3-bet.`
          : `Correct fold. ${heroHandStr} is outside your range here.${nearBubble ? ' With the bubble approaching, patience is even more valuable.' : isNearFinalTable ? ' Near the final table, ICM pressure is high — don\'t gamble with marginal hands.' : ' Patient folding is a tournament edge.'}`
        : foldQuality === 'ok'
        ? `Marginal fold. ${heroHandStr} is outside your standard range but pot odds of ${Math.round(foldPotOdds * 100)}% make calling borderline acceptable.`
        : `Too tight. ${heroHandStr} is in your range — don't surrender equity.`,
    })

    // SB complete when facing limpers only (no raise)
    if (heroSeat.position === 'SB' && raisers === 0 && limpers > 0) {
      const sbCallCost = Math.min(
        heroSeat.stack,
        Math.max(0, bb - heroSeat.invested)
      )
      if (sbCallCost > 0) {
        options.push({
          label: `Call ${sbCallCost.toLocaleString()}`,
          type: 'call',
          amount: bb,
          chipCost: sbCallCost,
          quality: (inRFI || inCall || heroHandStr.endsWith('s')) ? 'ok' : 'bad',
          coaching: `Completing the SB gives you good pot odds but you'll be out of position for every postflop street. Raising is usually better — take initiative and deny equity to limpers.`,
        })
      }
    }

    // Check option for BB when no raise
    if (heroSeat.position === 'BB' && raisers === 0 && currentBet <= bb) {
      options.push({
        label: 'Check — take free flop',
        type: 'check',
        amount: 0,
        chipCost: 0,
        quality: inRFI ? 'ok' : 'good',
        coaching: `BB gets a free look. ${heroHandStr} can see the flop for free — check and evaluate postflop.`,
      })
    }

    // Limp (early levels only, when no raise yet)
    if (levelIndex < 8 && raisers === 0 && currentBet === bb) {
      options.push({
        label: `Limp ${bb.toLocaleString()}`,
        type: 'limp',
        amount: bb,
        chipCost: bb,
        quality: 'ok',
        coaching: `Limping is acceptable in early levels. Be aware of your postflop position and stack depth.`,
      })
    }

    // Call / overcall limpers
    if (currentBet > 0 && (raisers >= 1 || limpers >= 1)) {
      const callCost = Math.min(heroSeat.stack, Math.max(0, currentBet - heroSeat.invested))
      const isCallAllIn = callCost >= heroSeat.stack
      const leavingBehindBB = bb > 0 ? (heroSeat.stack - callCost) / bb : 0
      const callLeavesTooShort = raisers >= 1 && leavingBehindBB < 10 && !isCallAllIn
      const impliedPot = pot + callCost
      const callPotOdds = impliedPot > 0 ? callCost / impliedPot : 1

      const activePlayers = activeSeats?.length ?? 0
      const callQuality: Quality =
        callLeavesTooShort ? 'bad' :
        (raisers >= 3 && in4betContinue) ? 'ok' :
        (raisers >= 3) ? 'bad' :
        (raisers === 2 && activePlayers > 3 && inVs3betCall) ? 'ok' :
        (raisers === 2 && activePlayers > 3) ? 'bad' :
        (raisers === 2 && inVs3betCall) ? 'best' :
        (raisers === 2) ? 'bad' :
        (raisers === 1 && inCall && in3bet) ? 'good' :
        (raisers === 1 && inCall) ? 'best' :
        (raisers === 1 && in3bet) ? 'ok' :
        (callPotOdds < 0.15 && (inRFI || in3bet || heroHandStr.endsWith('s'))) ? 'good' :
        (callPotOdds < 0.20 && inRFI) ? 'ok' :
        'bad'
      options.push({
        label: isCallAllIn ? `Call All-In ${callCost.toLocaleString()}` : `Call ${currentBet.toLocaleString()}`,
        type: isCallAllIn ? 'shove' : 'call',
        amount: currentBet,
        chipCost: callCost,
        quality: callQuality,
        coaching: callQuality === 'best'
          ? `Good call. ${heroHandStr} is in your calling range. Pot odds: ${Math.round(callPotOdds * 100)}% — well within equity threshold.`
          : (callQuality === 'good' && in3bet)
          ? `Calling is fine but 3-betting is better. ${heroHandStr} is in your 3-bet range — build the pot and deny equity to the field.`
          : callQuality === 'good'
          ? `Reasonable call. ${heroHandStr} has implied odds — ${Math.round(callPotOdds * 100)}% pot odds with good postflop playability.`
          : callQuality === 'ok'
          ? `Marginal call. ${heroHandStr} at ${Math.round(callPotOdds * 100)}% pot odds — consider 3-betting for fold equity instead.${nearBubble ? ' On the bubble, avoid marginal calls that could cripple your stack.' : ''}`
          : callLeavesTooShort
          ? `Calling here leaves only ${Math.round(leavingBehindBB)}BB behind — a stack too short to play postflop effectively.${nearBubble ? ' On the bubble especially, never call yourself into a crippled stack. Shove or fold.' : ' Shove for maximum pressure or fold. Never call and leave yourself crippled.'}`
          : `Calling ${heroHandStr} here leaks chips. ${Math.round(callPotOdds * 100)}% pot odds but the hand lacks equity vs this range. Fold or raise.`,
      })
    }

    // Open raise / 3-bet / 4-bet
    let threeBetCommitsStack = false
    if (depth >= 20) {
      if (raisers === 0) {
        // Open raise
        const openSize = getOpenSize(levelIndex, heroSeat.stack,
          heroSeat.position === 'BTN' || heroSeat.position === 'CO')
        // openSize already comes from getOpenSize — ensure rounded to 100
        const openSizeRounded = Math.round(openSize / 100) * 100
        const raiseQuality: Quality = inRFI ? 'best' : 'bad'
        options.push({
          label: `Raise to ${openSizeRounded.toLocaleString()}`,
          type: 'raise',
          amount: openSizeRounded,
          chipCost: openSizeRounded,
          quality: raiseQuality,
          coaching: raiseQuality === 'best'
            ? `Standard. ${heroHandStr} from ${heroSeat.position} — raise and take initiative.`
            : `Weak open. ${heroHandStr} is outside your RFI range from ${heroSeat.position}. Fold.`,
        })
      } else if (raisers === 1) {
        // 3-bet
        const depth = getBBDepth(heroSeat.stack, levelIndex)
        // 3-bet sizing: 2.5x the raise + 1 raise unit per caller
        // Formula: currentBet × (2.5 + callers)
        // Correctly prices out implied odds hands and accounts for dead money
        const callerCount = limpers  // limpers = players who called the raise
        const rawThreeBet = Math.round(currentBet * (2.5 + callerCount) / 100) * 100
        const threeBetSize = rawThreeBet
        threeBetCommitsStack = rawThreeBet > heroSeat.stack * 0.4 ||
          (heroSeat.stack - rawThreeBet) < getBB(levelIndex) * 12
        const inSqueezeRange = isSqueeze && (inCall || inRFI) &&
          (heroHandStr.endsWith('s') ||
           ['99','88','77','AJo','KQo'].includes(heroHandStr))
        const threeBetQuality: Quality = in3bet ? 'best' :
          inSqueezeRange ? 'good' :
          'bad'
        if (!threeBetCommitsStack) {
          options.push({
            label: `3-bet to ${threeBetSize.toLocaleString()}`,
            type: 'raise',
            amount: threeBetSize,
            chipCost: threeBetSize,
            quality: threeBetQuality,
            coaching: threeBetQuality === 'best'
              ? isSqueeze
                ? `Squeeze play with ${heroHandStr}. There's ${fmtChips(squeezeDeadMoney)} in dead money — 3-bet to pick it up. Callers are in a terrible spot.`
                : `Correct 3-bet. ${heroHandStr} is in your 3-bet range — build the pot and apply pressure.`
              : threeBetQuality === 'good'
              ? `Good squeeze spot. ${heroHandStr} is not in your standard 3-bet range but the dead money from ${limpers} caller${limpers > 1 ? 's' : ''} makes this a profitable squeeze.`
              : `Don't 3-bet ${heroHandStr} here. It's in your calling range, not your 3-bet range. Call if the odds are right, otherwise fold.`,
          })
        }
      } else if (raisers >= 2) {
        // 4-bet
        const fourBetSize = Math.round(currentBet * 2.5 / 100) * 100
        const fourBetQuality: Quality = in4bet ? 'best' : 'bad'
        options.push({
          label: `4-bet to ${fourBetSize.toLocaleString()}`,
          type: 'raise',
          amount: fourBetSize,
          chipCost: fourBetSize,
          quality: fourBetQuality,
          coaching: fourBetQuality === 'best'
            ? `Correct 4-bet. ${heroHandStr} is premium enough to go for it.`
            : `4-betting ${heroHandStr} here is a bluff with no blocker value. Fold.`,
        })
      }
    }

    // Shove
    if (depth < 20 || threeBetCommitsStack) {
      const shoveQuality: Quality =
        (raisers >= 3 && in4betContinue) ? 'best' :
        (raisers >= 3) ? 'bad' :
        (raisers >= 1 && threeBetCommitsStack && in4betContinue) ? 'best' :
        (raisers >= 1 && threeBetCommitsStack) ? 'ok' :
        inShove ? 'best' :
        (depth < 15) ? 'ok' :
        'bad'
      options.push({
        label: `Shove ${heroSeat.stack.toLocaleString()}`,
        type: 'shove',
        amount: heroSeat.stack,
        chipCost: heroSeat.stack,
        quality: shoveQuality,
        coaching: shoveQuality === 'best'
          ? raisers >= 3
            ? `Mandatory shove. Facing a 4-bet with ${heroHandStr} — this is a get-it-in spot. Never fold a premium here.`
            : `Correct shove. ${heroHandStr} at ${depth}BB — maximum pressure.${nearBubble ? ' Note: near the bubble, be sure villain has enough equity to call before shoving.' : ''}`
          : shoveQuality === 'ok'
          ? `Marginal shove. ${heroHandStr} has some equity but may be dominated. Consider folding.`
          : raisers >= 3
          ? `Correct fold. ${heroHandStr} is not strong enough to continue vs a 4-bet.`
          : `Too deep to shove ${heroHandStr}. Raise smaller or fold.`,
      })
    }

    return options
  }

  // ── POSTFLOP ─────────────────────────────────────────────
  const hs = heroSeat.holeCards
    ? evalHand(heroSeat.holeCards[0], heroSeat.holeCards[1], board)
    : null

  const texture = board.length >= 3 ? classifyBoardTexture(board) : 'dry'
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
    const callQuality: Quality = hs && hs.str >= 2 ? 'best' :
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
        ? `Good call. ${hs?.label || 'Your hand'} has the equity to continue.`
        : callQuality === 'ok'
        ? `Marginal call. You're getting reasonable odds but the hand is weak.`
        : `Calling here with ${hs?.label || 'this hand'} is a chip leak. Fold or raise.`,
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
    (heroDonking && hs && hs.str < 2 && !hs.heroFD && !hs.oesd) ? 'best' :
    (hs && hs.str === 0 && !hs.heroFD && !hs.oesd) ? 'best' :
    (hs && hs.str >= 2 && street === 'river') ? 'bad' :
    (activePlayers >= 4 && hs && hs.str === 1 &&
      hs.pairPos !== 'toppair' && hs.pairPos !== 'overpair') ? 'best' :
    'ok'
  options.push({
    label: 'Check',
    type: 'check',
    amount: 0,
    chipCost: 0,
    quality: checkQuality,
    coaching: checkQuality === 'best'
      ? (heroDonking && hs && hs.str < 2
        ? `Check here — don't donk bet weak hands into the preflop raiser. Let them c-bet and react with your hand strength.`
        : `High card has little equity. Check and see a free card.`)
      : checkQuality === 'bad'
      ? `Never slowplay ${hs?.label ?? 'this hand'} on the river. Bet for value — checking gives free showdowns.`
      : heroDonking
      ? `Checking is preferred OOP. You can lead the river when you have a clear value hand.`
      : `Checking is fine for pot control.${nearBubble ? ' Near the bubble, pot control is especially important — don\'t inflate pots without strong hands.' : ' Be ready to call a reasonable bet.'}${priorBetDesc}`,
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
    if (heroDonking) {
      if (hs.str >= 3) return 'good'
      if (hs.str === 2) return 'ok'
      if (hs.heroFD && hs.oesd) return 'ok'
      return 'bad'
    }
    if (hs.str >= 5) return 'best'
    if (hs.str === 4) return sizing === 'sm' ? 'good' : 'best'
    if (hs.str === 3) return sizing === 'lg' ? 'ok' : 'best'
    if (hs.str === 2) return sizing === 'med' ? 'best' : 'good'
    if (hs.str === 1 && hs.pairPos === 'toppair') return sizing === 'sm' ? 'best' : sizing === 'med' ? 'good' : 'ok'
    if (hs.str === 1) return sizing === 'sm' ? 'ok' : 'bad'
    if (hs.str === 0) return street === 'river' ? 'bad' : 'ok'
    return 'ok'
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
        : `Small bet on ${texStrat.label} board. ${texStrat.note}`,
    })
  }

  if (!skipBetMed) {
    options.push({
      label: `Bet ${betMed.toLocaleString()} (${Math.round(texStrat.cBetSizing * 100)}% pot)`,
      type: 'raise',
      amount: betMed,
      chipCost: betMed,
      quality: betQuality(hs, 'med'),
      coaching: `Standard sizing. ${texStrat.note}${nearBubbleNote}`,
    })
  }

  if (!skipBetMed) {
    options.push({
      label: `Bet ${betLg.toLocaleString()} (large)`,
      type: 'raise',
      amount: betLg,
      chipCost: betLg,
      quality: betQuality(hs, 'lg'),
      coaching: `Large bet. Use this with strong hands that want to build the pot or strong draws charging a price.`,
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
    isOver: false,
    heroWon: false,
    isTie: false,
    showdownSeat: null,
  }

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

    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
    } else if (result.action.type === 'limp') {
      const cost = bb - seat.invested
      seat.stack -= cost
      seat.invested += cost
      engine.pot += cost
      limpers++
      actionLines.push(result.desc)
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
    } else if (result.action.type === 'call') {
      const cost = currentBet - seat.invested
      seat.stack -= cost
      seat.invested += cost
      engine.pot += cost
      limpers++
      actionLines.push(result.desc)
    }
  }

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

    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
    } else if (result.action.type === 'call' || result.action.type === 'limp') {
      const callCost = Math.min(seat.stack, currentBet - seat.invested)
      seat.stack -= callCost
      seat.invested += callCost
      engine.pot += callCost
      if (seat.stack === 0) seat.allIn = true
      actionLines.push(result.desc)
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
    } else if (result.action.type === 'check') {
      actionLines.push(result.desc)
    }
  }

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
      ),
      activePlayers: engine.activeSeats.filter(s => !s.folded).length,
      lastAggressor: lastAggressorSeat,
    }
  }

  // Only one player remains — hand over
  const stillIn = engine.activeSeats.filter(s => !s.folded)
  if (stillIn.length === 1) {
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

    if (result.action.type === 'fold') {
      seat.folded = true
      engine.activeSeats = engine.activeSeats.filter(s => s.seatIndex !== seat.seatIndex)
      actionLines.push(result.desc)
    } else if (result.action.type === 'check') {
      actionLines.push(result.desc)
    } else if (result.action.type === 'raise') {
      const betCost = result.action.amount
      seat.stack -= betCost
      seat.invested += betCost
      engine.pot += betCost
      currentBet = betCost
      lastAggressorSeat = seat
      actionLines.push(result.desc)
    } else if (result.action.type === 'call') {
      const callCost = result.action.amount
      seat.stack -= callCost
      seat.invested += callCost
      engine.pot += callCost
      actionLines.push(result.desc)
    }
  }

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
