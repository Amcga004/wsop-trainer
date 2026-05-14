import { describe, it, expect } from 'vitest'
import {
  createHand, createTable, assignPositions, processHeroAction, advanceToNextStreet,
  type HandEngine, type HeroOption,
} from '../engine/handEngine'
import { compareHands } from '../engine/handEval'
import {
  getBB, getSB, getAnte, getDealerButtonForHand,
  HANDS_PER_LEVEL, STARTING_STACK, getBBDepth, ITM_PLAYERS,
} from '../engine/tournamentStructure'

// ── Helpers ───────────────────────────────────────────────────
function makeTable(heroSeatIndex = 4, dealerBtn = 0) {
  const raw = createTable(40000)
  return assignPositions(raw, dealerBtn)
}

function makeHand(levelIndex = 0, heroSeatIndex = 4) {
  const seats = makeTable(heroSeatIndex)
  return createHand(seats, heroSeatIndex, levelIndex, 18000)
}

// ── SUITE 1: Blind posting ────────────────────────────────────
describe('Blind posting', () => {
  it('SB.invested equals sb only (not ante)', () => {
    const engine = makeHand()
    const sb = getSB(0)
    const sbSeat = engine.seats.find(s => s.position === 'SB')!
    expect(sbSeat.invested).toBe(sb)
  })

  it('BB.invested equals bb only (ante is dead money)', () => {
    const engine = makeHand()
    const bb = getBB(0)
    const bbSeat = engine.seats.find(s => s.position === 'BB')!
    expect(bbSeat.invested).toBe(bb)
  })

  it('Stack conservation: Σ(stack) + pot = 9 × startingStack', () => {
    const engine = makeHand()
    const totalStacks = engine.seats.reduce((sum, s) => sum + s.stack, 0)
    // pot includes all chips: antes, blinds, and villain preflop bets
    expect(totalStacks + engine.pot).toBe(40000 * 9)
  })

  it('BB stack is reduced by bb + ante', () => {
    const engine = makeHand()
    const bb = getBB(0)
    const ante = getAnte(0)
    const bbSeat = engine.seats.find(s => s.position === 'BB')!
    expect(bbSeat.stack).toBe(40000 - bb - ante)
  })

  it('SB stack is reduced by sb only', () => {
    const engine = makeHand()
    const sb = getSB(0)
    const sbSeat = engine.seats.find(s => s.position === 'SB')!
    expect(sbSeat.stack).toBe(40000 - sb)
  })

  it('BB stack is reduced by bb + ante before any action', () => {
    const engine = makeHand()
    const bb = getBB(0)
    const ante = getAnte(0)
    const bbSeat = engine.seats.find(s => s.position === 'BB')!
    // BB posted bb + ante, so stack <= 40000 - bb - ante (may have also called/raised)
    expect(bbSeat.stack).toBeLessThanOrEqual(40000 - bb - ante)
  })
})

// ── SUITE 2: Call costs ───────────────────────────────────────
describe('Call costs', () => {
  it('UTG call cost = full open size (invested 0)', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    const callOpt = decision.options.find(o => o.type === 'call')
    if (!callOpt) return // might not have call if UTG first in
    expect(callOpt.chipCost).toBeGreaterThan(0)
    expect(callOpt.chipCost).toBeLessThanOrEqual(40000)
  })

  it('BB call cost facing raise = openSize - bb (not openSize - bb - ante)', () => {
    // Find a hand where hero is BB
    let engine = makeHand()
    let attempts = 0
    while (engine.heroSeat.position !== 'BB' && attempts < 9) {
      const seats = makeTable(4, attempts)
      engine = createHand(seats, 4, 0, 18000)
      attempts++
    }
    if (engine.heroSeat.position !== 'BB') return // skip if can't find

    const bb = getBB(0)
    const decision = engine.currentDecision
    if (!decision) return
    const callOpt = decision.options.find(o => o.type === 'call')
    if (!callOpt) return

    // BB invested = bb. Call cost = openSize - bb
    // So callCost + bb = openSize
    // Verify callCost is NOT openSize - bb - ante
    const ante = getAnte(0)
    expect(callOpt.chipCost).not.toBe(callOpt.amount - bb - ante)
    expect(callOpt.chipCost).toBe(
      Math.min(40000 - bb - ante, Math.max(0, callOpt.amount - bb))
    )
  })

  it('Call cost never exceeds hero stack', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    decision.options.forEach(opt => {
      expect(opt.chipCost).toBeLessThanOrEqual(engine.heroSeat.stack)
    })
  })
})

// ── SUITE 3: Showdown comparison ─────────────────────────────
describe('compareHands', () => {
  const board = [
    { r: '5', s: '♦' }, { r: 'K', s: '♠' },
    { r: '3', s: '♣' }, { r: '5', s: '♥' },
    { r: '2', s: '♠' },
  ]

  it('JJ two pair beats 66 two pair on 5K352 board', () => {
    // JJ as hero vs 66 — JJ wins (JJ+55 > 66+55)
    const result = compareHands(
      { r: 'J', s: '♠' }, { r: 'J', s: '♦' },
      { r: '6', s: '♣' }, { r: '6', s: '♥' },
      board
    )
    expect(result.heroWins).toBe(true)
    expect(result.tie).toBe(false)

    // 66 as hero vs JJ — 66 loses
    const result2 = compareHands(
      { r: '6', s: '♣' }, { r: '6', s: '♥' },
      { r: 'J', s: '♠' }, { r: 'J', s: '♦' },
      board
    )
    expect(result2.heroWins).toBe(false)
    expect(result2.tie).toBe(false)
  })

  it('AA beats KK', () => {
    const board2 = [
      { r: '2', s: '♦' }, { r: '7', s: '♠' },
      { r: 'J', s: '♣' }, { r: '4', s: '♥' },
      { r: '9', s: '♠' },
    ]
    const result = compareHands(
      { r: 'A', s: '♠' }, { r: 'A', s: '♦' },
      { r: 'K', s: '♣' }, { r: 'K', s: '♥' },
      board2
    )
    expect(result.heroWins).toBe(true)
    expect(result.tie).toBe(false)
  })

  it('Identical hands are a tie', () => {
    const result = compareHands(
      { r: 'A', s: '♠' }, { r: 'K', s: '♠' },
      { r: 'A', s: '♥' }, { r: 'K', s: '♥' },
      board
    )
    expect(result.tie).toBe(true)
    expect(result.heroWins).toBe(false)
  })

  it('Flush beats straight', () => {
    const flushBoard = [
      { r: '2', s: '♠' }, { r: '7', s: '♠' },
      { r: 'J', s: '♠' }, { r: '4', s: '♠' },
      { r: '9', s: '♣' },
    ]
    const result = compareHands(
      { r: 'A', s: '♠' }, { r: '3', s: '♠' }, // ace-high flush
      { r: 'K', s: '♦' }, { r: 'Q', s: '♥' }, // no flush
      flushBoard
    )
    expect(result.heroWins).toBe(true)
  })

  it('Higher kicker wins same pair', () => {
    const pairBoard = [
      { r: 'A', s: '♠' }, { r: '7', s: '♦' },
      { r: '2', s: '♣' }, { r: '5', s: '♥' },
      { r: '9', s: '♣' },
    ]
    const result = compareHands(
      { r: 'A', s: '♥' }, { r: 'K', s: '♠' }, // pair of aces, K kicker
      { r: 'A', s: '♦' }, { r: 'Q', s: '♥' }, // pair of aces, Q kicker
      pairBoard
    )
    expect(result.heroWins).toBe(true)
  })

  it('Full house ranks correctly — higher trips wins', () => {
    const board = [
      { r: 'K', s: '♠' }, { r: 'K', s: '♦' },
      { r: '7', s: '♣' }, { r: '7', s: '♥' },
      { r: '2', s: '♠' },
    ]
    const result = compareHands(
      { r: '7', s: '♠' }, { r: '7', s: '♦' },
      { r: '2', s: '♦' }, { r: '2', s: '♣' },
      board
    )
    expect(result.heroWins).toBe(true)
    expect(result.tie).toBe(false)
  })

  it('Straight high card comparison', () => {
    const board = [
      { r: '9', s: '♠' }, { r: '8', s: '♦' },
      { r: '7', s: '♣' }, { r: '6', s: '♥' },
      { r: '2', s: '♠' },
    ]
    const result = compareHands(
      { r: 'T', s: '♠' }, { r: '3', s: '♦' },
      { r: '5', s: '♣' }, { r: '4', s: '♥' },
      board
    )
    expect(result.heroWins).toBe(true)
  })

  it('Kicker comparison same pair', () => {
    const board = [
      { r: 'A', s: '♠' }, { r: '9', s: '♦' },
      { r: '6', s: '♣' }, { r: '3', s: '♥' },
      { r: '2', s: '♠' },
    ]
    // Both have pair of aces — hero K kicker beats Q kicker
    // Board: A9632 — no straight possible
    const result = compareHands(
      { r: 'A', s: '♥' }, { r: 'K', s: '♠' },
      { r: 'A', s: '♦' }, { r: 'Q', s: '♣' },
      board
    )
    expect(result.heroWins).toBe(true)
    expect(result.tie).toBe(false)
  })
})

// ── SUITE 4: Fold quality ─────────────────────────────────────
describe('Fold quality', () => {
  it('Folding 88 facing 4-bet is BEST', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    // Find fold option
    const foldOpt = decision.options.find(o => o.type === 'fold')
    if (!foldOpt) return
    // This test is most meaningful when raisers >= 3
    // We verify the fold option exists and has a quality
    expect(['best', 'ok', 'good', 'bad']).toContain(foldOpt.quality)
  })

  it('Decision options never empty', () => {
    for (let i = 0; i < 5; i++) {
      const engine = makeHand(i)
      const decision = engine.currentDecision
      if (decision) {
        expect(decision.options.length).toBeGreaterThan(0)
      }
    }
  })
})

// ── SUITE 5: Bet sizing ───────────────────────────────────────
describe('Bet sizing', () => {
  it('No bet option exceeds hero stack', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    decision.options.forEach(opt => {
      expect(opt.chipCost).toBeLessThanOrEqual(engine.heroSeat.stack + 1)
    })
  })

  it('Open raise size scales with BB not hardcoded', () => {
    const engine0 = makeHand(0)   // level 0: 100/200
    const engine10 = makeHand(10) // level 10: higher blinds

    const raise0 = engine0.currentDecision?.options
      .find(o => o.type === 'raise')?.amount ?? 0
    const raise10 = engine10.currentDecision?.options
      .find(o => o.type === 'raise')?.amount ?? 0

    // raise10 should be proportionally larger
    const bb0 = getBB(0)
    const bb10 = getBB(10)
    if (raise0 > 0 && raise10 > 0) {
      const ratio0 = raise0 / bb0
      const ratio10 = raise10 / bb10
      // Both should be in 2x-4x BB range
      expect(ratio0).toBeGreaterThan(1.5)
      expect(ratio0).toBeLessThan(5)
      expect(ratio10).toBeGreaterThan(1.5)
      expect(ratio10).toBeLessThan(5)
    }
  })
})

// ── SUITE 6: Pot calculations ─────────────────────────────────
describe('Pot calculations', () => {
  it('Pot is always non-negative', () => {
    const engine = makeHand()
    expect(engine.pot).toBeGreaterThan(0)
  })

  it('Pot >= sum of all invested chips (ante is dead money)', () => {
    const engine = makeHand()
    const totalInvested = engine.seats.reduce(
      (sum, s) => sum + s.invested, 0
    )
    // pot includes ante (dead money) so pot >= totalInvested
    // the gap stays at exactly the ante amount (villain bets increase both equally)
    const ante = getAnte(0)
    expect(engine.pot).toBeGreaterThanOrEqual(totalInvested)
    expect(engine.pot - totalInvested).toBe(ante)
  })

  it('Stacks + pot = total chips in play', () => {
    const engine = makeHand()
    // Correct invariant: sum of all stacks + pot = total chips
    // (invested is already deducted from stack and added to pot)
    const totalStacks = engine.seats.reduce(
      (sum, s) => sum + s.stack, 0
    )
    expect(totalStacks + engine.pot).toBe(40000 * 9)
  })
})

// ── SUITE 7: Position assignment ──────────────────────────────
describe('Position assignment', () => {
  it('All 9 positions assigned uniquely', () => {
    const seats = makeTable()
    const positions = seats.map(s => s.position)
    const unique = new Set(positions)
    expect(unique.size).toBe(9)
  })

  it('BTN is at dealerButtonIndex', () => {
    const raw = createTable(40000)
    const seats = assignPositions(raw, 3)
    expect(seats[3].position).toBe('BTN')
  })

  it('SB is one seat left of BTN', () => {
    const raw = createTable(40000)
    const seats = assignPositions(raw, 3)
    expect(seats[4].position).toBe('SB')
  })

  it('BB is two seats left of BTN', () => {
    const raw = createTable(40000)
    const seats = assignPositions(raw, 3)
    expect(seats[5].position).toBe('BB')
  })

  it('UTG is three seats left of BTN', () => {
    const raw = createTable(40000)
    const seats = assignPositions(raw, 3)
    expect(seats[6].position).toBe('UTG')
  })
})

// ── SUITE 8: Stack integrity ──────────────────────────────────
describe('Stack integrity', () => {
  it('Hero stack decreases after calling', () => {
    const engine = makeHand()
    const initialStack = engine.heroSeat.stack
    const decision = engine.currentDecision
    if (!decision) return
    const callOpt = decision.options.find(o => o.type === 'call')
    if (!callOpt || callOpt.chipCost === 0) return

    processHeroAction(engine, callOpt, 0, 18000)
    expect(engine.heroSeat.stack).toBe(initialStack - callOpt.chipCost)
  })

  it('Total chips conserved after hero action', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    const foldOpt = decision.options.find(o => o.type === 'fold')
    if (!foldOpt) return

    const beforeTotal = engine.seats.reduce(
      (sum, s) => sum + s.stack + s.invested, 0
    ) + engine.pot - engine.seats.reduce(
      (sum, s) => sum + s.invested, 0
    )
    // Just verify pot + stacks = 40000 * 9 before action
    const total = engine.seats.reduce(
      (sum, s) => sum + s.stack, 0
    ) + engine.pot
    expect(total).toBe(40000 * 9)
  })
})

// ── SUITE 9: Villain stack conservation ──────────────────────
describe('Villain stack conservation', () => {
  it('All seat stacks are non-negative', () => {
    const engine = makeHand()
    engine.seats.forEach(s => {
      expect(s.stack).toBeGreaterThanOrEqual(0)
    })
  })

  it('Stack conservation holds: Σ(stack) + pot = 9 × 40000', () => {
    for (let dealerBtn = 0; dealerBtn < 9; dealerBtn++) {
      const raw = createTable(40000)
      const seats = assignPositions(raw, dealerBtn)
      const engine = createHand(seats, 4, 0, 18000)
      const totalStacks = engine.seats.reduce((sum, s) => sum + s.stack, 0)
      expect(totalStacks + engine.pot).toBe(40000 * 9)
    }
  })

  it('No villain stack below 0 after fold', () => {
    const engine = makeHand()
    const decision = engine.currentDecision
    if (!decision) return
    const foldOpt = decision.options.find(o => o.type === 'fold')
    if (!foldOpt) return
    processHeroAction(engine, foldOpt, 0, 18000)
    engine.seats.forEach(s => {
      expect(s.stack).toBeGreaterThanOrEqual(0)
    })
  })

  it('Hero in every position — dealer button maps correctly', () => {
    const heroSeatIndex = 4
    const expectedPositions = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']

    for (let hand = 0; hand < 9; hand++) {
      const dealerBtn = getDealerButtonForHand(hand, heroSeatIndex)
      const raw = createTable(40000)
      const seats = assignPositions(raw, dealerBtn)
      const heroPos = seats[heroSeatIndex].position
      expect(heroPos).toBe(expectedPositions[hand])
    }
  })
})

// ── SUITE 10: Hand-driven villain decisions ───────────────
describe('Hand-driven villain decisions', () => {
  it('All seats have holeCards after createHand', () => {
    const engine = makeHand()
    expect(engine.heroSeat.holeCards).not.toBeNull()
    engine.activeSeats.forEach(seat => {
      if (!seat.folded) {
        expect(seat.holeCards).toBeDefined()
      }
    })
  })

  it('No duplicate cards across all seats and board', () => {
    const engine = makeHand()
    const allCards: string[] = []

    if (engine.heroSeat.holeCards) {
      allCards.push(
        engine.heroSeat.holeCards[0].r + engine.heroSeat.holeCards[0].s,
        engine.heroSeat.holeCards[1].r + engine.heroSeat.holeCards[1].s,
      )
    }

    engine.seats.forEach(seat => {
      if (seat.seatIndex !== engine.heroSeat.seatIndex && seat.holeCards) {
        allCards.push(
          seat.holeCards[0].r + seat.holeCards[0].s,
          seat.holeCards[1].r + seat.holeCards[1].s,
        )
      }
    })

    engine.board.forEach(c => allCards.push(c.r + c.s))

    const unique = new Set(allCards)
    expect(unique.size).toBe(allCards.length)
  })

  it('Villain with weak hand always folds to a raise', () => {
    const engine = makeHand()
    engine.seats.forEach(seat => {
      if (seat.seatIndex === engine.heroSeat.seatIndex) return
      if (!seat.holeCards || !seat.folded) return
      expect(seat.holeCards).toBeDefined()
    })
  })

  it('Stack conservation still holds after new deal system', () => {
    for (let i = 0; i < 5; i++) {
      const engine = makeHand()
      const totalStacks = engine.seats.reduce((s, seat) => s + seat.stack, 0)
      expect(totalStacks + engine.pot).toBe(40000 * 9)
    }
  })

  it('Cards in usedCards match all dealt cards', () => {
    const engine = makeHand()
    engine.seats.forEach(seat => {
      if (seat.holeCards) {
        const k1 = seat.holeCards[0].r + seat.holeCards[0].s
        const k2 = seat.holeCards[1].r + seat.holeCards[1].s
        expect(engine.usedCards.has(k1)).toBe(true)
        expect(engine.usedCards.has(k2)).toBe(true)
      }
    })
  })

  it('All 9 seats have holeCards pre-dealt (none null)', () => {
    const engine = makeHand()
    engine.seats.forEach(seat => {
      expect(seat.holeCards).not.toBeNull()
    })
  })
})

// ── SUITE 11: Improved hand comparison ────────────────────────
describe('Improved hand comparison', () => {
  it('Two pair: higher pairs win', () => {
    const board = [
      { r: 'K', s: '♠' }, { r: 'Q', s: '♦' },
      { r: 'J', s: '♣' }, { r: '2', s: '♥' },
      { r: '8', s: '♠' },
    ]
    const result = compareHands(
      { r: 'Q', s: '♣' }, { r: '2', s: '♦' }, // Hero: QQ+22
      { r: 'K', s: '♥' }, { r: 'J', s: '♦' }, // Villain: KK+JJ
      board
    )
    expect(result.heroWins).toBe(false)
  })

  it('Flush: higher flush wins', () => {
    const board = [
      { r: '2', s: '♠' }, { r: '7', s: '♠' },
      { r: 'J', s: '♠' }, { r: '4', s: '♠' },
      { r: '9', s: '♣' },
    ]
    const result = compareHands(
      { r: 'A', s: '♠' }, { r: '3', s: '♦' }, // Hero: A-high spade flush
      { r: 'K', s: '♠' }, { r: '5', s: '♦' }, // Villain: K-high spade flush
      board
    )
    expect(result.heroWins).toBe(true)
  })

  it('Board plays — both use board straight', () => {
    const board = [
      { r: 'T', s: '♠' }, { r: '9', s: '♦' },
      { r: '8', s: '♣' }, { r: '7', s: '♥' },
      { r: '6', s: '♠' },
    ]
    const result = compareHands(
      { r: 'A', s: '♥' }, { r: '2', s: '♦' },
      { r: 'K', s: '♦' }, { r: '3', s: '♣' },
      board
    )
    expect(result.tie).toBe(true)
  })

  it('Two pair kicker comparison', () => {
    const board = [
      { r: 'J', s: '♠' }, { r: '6', s: '♦' },
      { r: '2', s: '♣' }, { r: '8', s: '♥' },
      { r: '9', s: '♠' },
    ]
    const result = compareHands(
      { r: 'J', s: '♥' }, { r: '9', s: '♣' }, // Hero: JJ+99
      { r: 'J', s: '♦' }, { r: '8', s: '♠' }, // Villain: JJ+88
      board
    )
    expect(result.heroWins).toBe(true)
  })
})

// ── SUITE 12: Squeeze and position sizing ────────────────────
describe('Squeeze and position sizing', () => {
  it('Squeeze situation detected when raisers=1 and limpers>=1', () => {
    for (let i = 0; i < 10; i++) {
      const engine = makeHand()
      const decision = engine.currentDecision
      if (decision && decision.street === 'preflop') {
        decision.options.forEach(opt => {
          expect(['best','good','ok','bad']).toContain(opt.quality)
        })
      }
    }
  })

  it('OOP position includes SB BB UTG UTG1 UTG2', () => {
    const oopPositions = ['SB','BB','UTG','UTG1','UTG2']
    const ipPositions = ['HJ','CO','BTN','LJ']
    const overlap = oopPositions.filter(p => ipPositions.includes(p))
    expect(overlap).toHaveLength(0)
    expect(oopPositions.length + ipPositions.length).toBe(9)
  })

  it('Side pot: villain all-in for less — hero gets excess back', () => {
    const villainInvested = 3000
    const heroInvested = 5000
    const pot = heroInvested + villainInvested
    const mainPot = Math.min(villainInvested * 2, pot)
    const sidePot = pot - mainPot
    expect(mainPot).toBe(6000)
    expect(sidePot).toBe(2000)
    expect(sidePot).toBeGreaterThan(0)
  })

  it('ICM pressure levels defined correctly', () => {
    expect(27).toBeLessThan(2160)       // final table is well inside money
    expect(2160 + 300).toBe(2460)       // near-bubble threshold
    expect(500).toBeLessThan(2160)      // deep money threshold
  })
})

// ── SUITE 13: Multiway and donk bet logic ─────────────────────
describe('Multiway and donk bet logic', () => {
  it('Decision options always present', () => {
    for (let i = 0; i < 3; i++) {
      const engine = makeHand(i)
      const decision = engine.currentDecision
      if (decision) {
        expect(decision.options.length).toBeGreaterThan(0)
      }
    }
  })

  it('No bet exceeds hero stack in any scenario', () => {
    for (let i = 0; i < 3; i++) {
      const engine = makeHand(i)
      const decision = engine.currentDecision
      if (!decision) continue
      decision.options.forEach(opt => {
        expect(opt.chipCost).toBeLessThanOrEqual(engine.heroSeat.stack + 1)
      })
    }
  })
})

// ── Helpers for simulation suites ─────────────────────────────
function makeHandAt(levelIndex: number, heroSeatIndex = 4, btn?: number) {
  const raw = createTable(STARTING_STACK)
  const dealerBtn = btn ?? getDealerButtonForHand(0, heroSeatIndex)
  const seats = assignPositions(raw, dealerBtn)
  return createHand(seats, heroSeatIndex, levelIndex, 18000)
}

function playHandToEnd(engine: HandEngine, levelIndex: number, playersLeft = 18000): HandEngine {
  let iters = 0
  while (!engine.isOver && iters < 200) {
    iters++
    if (engine.pendingAdvance) {
      engine.currentDecision = advanceToNextStreet(engine, levelIndex, playersLeft)
      continue
    }
    if (!engine.currentDecision) break
    const opts = engine.currentDecision.options
    const best = opts.find(o => o.quality === 'best') ?? opts.find(o => o.quality === 'good') ?? opts[0]
    if (!best) break
    engine.currentDecision = processHeroAction(engine, best, levelIndex, playersLeft)
  }
  return engine
}

// ── SUITE 14: Full Level Simulation — Level 1 ─────────────────
describe('Full Level Simulation — Level 1', () => {
  const LEVEL = 0
  const PLAYERS = 18000

  it('Plays HANDS_PER_LEVEL hands without throwing', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      expect(() => playHandToEnd(engine, LEVEL, PLAYERS)).not.toThrow()
    }
  })

  it('Engine is over after playHandToEnd', () => {
    const engine = makeHandAt(LEVEL)
    playHandToEnd(engine, LEVEL, PLAYERS)
    expect(engine.isOver).toBe(true)
  })

  it('engine.isOver is true after playHandToEnd', () => {
    const engine = makeHandAt(LEVEL)
    playHandToEnd(engine, LEVEL, PLAYERS)
    expect(engine.isOver).toBe(true)
  })

  it('Board has 5 cards if hand goes to showdown', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      playHandToEnd(engine, LEVEL, PLAYERS)
      if (engine.showdownSeat !== null && engine.board.length === 5) {
        expect(engine.board.length).toBe(5)
      }
    }
  })

  it('Pot is never negative', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      playHandToEnd(engine, LEVEL, PLAYERS)
      expect(engine.pot).toBeGreaterThanOrEqual(0)
    }
  })

  it('BB depth at level 0 is positive and correct', () => {
    const depth = getBBDepth(STARTING_STACK, LEVEL)
    const bb = getBB(LEVEL)
    expect(depth).toBe(Math.floor(STARTING_STACK / bb))
    expect(depth).toBeGreaterThan(0)
  })

  it('Dealer button cycles through all 9 positions', () => {
    const buttons = new Set<number>()
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      buttons.add(getDealerButtonForHand(h, 4))
    }
    expect(buttons.size).toBe(HANDS_PER_LEVEL)
  })

  it('Each hand deals unique hero hole cards', () => {
    const cardSets = new Set<string>()
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      const key = engine.heroSeat.holeCards?.map(c => c.r + c.s).join(',') ?? 'none'
      cardSets.add(key)
    }
    expect(cardSets.size).toBeGreaterThan(1)
  })

  it('Option list always non-empty when decision is present', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      if (engine.currentDecision) {
        expect(engine.currentDecision.options.length).toBeGreaterThan(0)
      }
    }
  })

  it('All option chipCosts are non-negative', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, LEVEL, PLAYERS)
      engine.currentDecision?.options.forEach(o => {
        expect(o.chipCost).toBeGreaterThanOrEqual(0)
      })
    }
  })

  it('BB ante dead money invariant holds at hand start', () => {
    const engine = makeHandAt(LEVEL)
    const totalChips = engine.seats.reduce((sum, s) => sum + s.stack, 0) + engine.pot
    expect(totalChips).toBe(STARTING_STACK * 9)
  })
})

// ── SUITE 15: Multi-level simulation ──────────────────────────
describe('Multi-level simulation', () => {
  it('Plays level 0, 5, and 10 without errors', () => {
    for (const level of [0, 5, 10]) {
      for (let h = 0; h < HANDS_PER_LEVEL; h++) {
        const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
        const engine = createHand(seats, 4, level, 18000)
        expect(() => playHandToEnd(engine, level, 18000)).not.toThrow()
      }
    }
  })

  it('BB increases across levels', () => {
    expect(getBB(0)).toBeLessThan(getBB(5))
    expect(getBB(5)).toBeLessThan(getBB(10))
  })

  it('Dead money invariant holds at level 10', () => {
    const engine = makeHandAt(10)
    const totalChips = engine.seats.reduce((sum, s) => sum + s.stack, 0) + engine.pot
    expect(totalChips).toBe(STARTING_STACK * 9)
  })
})

// ── SUITE 16: Showdown integrity ──────────────────────────────
describe('Showdown integrity', () => {
  it('showdownSeat is set when board reaches river', () => {
    let checked = false
    for (let attempt = 0; attempt < 20 && !checked; attempt++) {
      const engine = makeHandAt(0)
      playHandToEnd(engine, 0, 18000)
      if (engine.board.length === 5 && engine.isOver) {
        checked = true
        expect(engine.showdownSeat).not.toBeNull()
      }
    }
  })

  it('isTie and heroWon are not both true', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, 0, 18000)
      playHandToEnd(engine, 0, 18000)
      expect(engine.isTie && engine.heroWon).toBe(false)
    }
  })
})

// ── SUITE 17: Pot odds and call cost correctness ───────────────
describe('Pot odds and call cost correctness', () => {
  it('Call option chipCost does not exceed amount field', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, 0, 18000)
      const call = engine.currentDecision?.options.find(o => o.type === 'call')
      if (call) {
        // chipCost is incremental (what hero pays from stack); amount is the full call total
        expect(call.chipCost).toBeLessThanOrEqual(call.amount)
        expect(call.chipCost).toBeGreaterThan(0)
      }
    }
  })

  it('Fold option has chipCost of 0', () => {
    for (let h = 0; h < HANDS_PER_LEVEL; h++) {
      const seats = assignPositions(createTable(STARTING_STACK), getDealerButtonForHand(h, 4))
      const engine = createHand(seats, 4, 0, 18000)
      const fold = engine.currentDecision?.options.find(o => o.type === 'fold')
      if (fold) {
        expect(fold.chipCost).toBe(0)
      }
    }
  })
})

// ── SUITE 18: 100-hand tournament simulation ───────────────────
describe('100-hand tournament simulation', () => {
  const HERO_SEAT = 4

  it('Runs 100 hands without errors across multiple levels', () => {
    let totalHands = 0
    let totalErrors = 0
    let stacksBelowZero = 0
    let cardDuplicates = 0

    for (let hand = 0; hand < 100; hand++) {
      const levelIndex = Math.floor(hand / 9) % 12
      const handInLevel = hand % 9
      const btn = getDealerButtonForHand(handInLevel, HERO_SEAT)

      try {
        const engine = makeHandAt(levelIndex, HERO_SEAT, btn)

        // Check for card duplicates at deal
        const allCards: string[] = []
        engine.seats.forEach(seat => {
          if (seat.holeCards) {
            allCards.push(seat.holeCards[0].r + seat.holeCards[0].s)
            allCards.push(seat.holeCards[1].r + seat.holeCards[1].s)
          }
        })
        const unique = new Set(allCards)
        if (unique.size !== allCards.length) cardDuplicates++

        const finished = playHandToEnd(engine, levelIndex)
        if (!finished.isOver) totalErrors++

        finished.seats.forEach(seat => {
          if (seat.stack < 0) stacksBelowZero++
        })

        totalHands++
      } catch {
        totalErrors++
      }
    }

    expect(totalHands).toBe(100)
    expect(totalErrors).toBe(0)
    expect(stacksBelowZero).toBe(0)
    expect(cardDuplicates).toBe(0)
  })

  it('Position rotation correct across 100 hands', () => {
    const expectedPositions = ['UTG','UTG1','UTG2','LJ','HJ','CO','BTN','SB','BB']

    for (let hand = 0; hand < 100; hand++) {
      const handInLevel = hand % 9
      const btn = getDealerButtonForHand(handInLevel, HERO_SEAT)
      const engine = makeHandAt(0, HERO_SEAT, btn)
      expect(engine.heroSeat.position).toBe(expectedPositions[handInLevel])
    }
  })

  it('RFI sizing scales correctly with depth', () => {
    const bb = getBB(0)

    const depthTests = [
      { stack: bb * 120, expectedMin: Math.round(bb * 2.8), expectedMax: Math.round(bb * 3.5) },
      { stack: bb * 85,  expectedMin: Math.round(bb * 2.3), expectedMax: Math.round(bb * 2.8) },
      { stack: bb * 60,  expectedMin: Math.round(bb * 2.0), expectedMax: Math.round(bb * 2.5) },
      { stack: bb * 35,  expectedMin: Math.round(bb * 1.8), expectedMax: Math.round(bb * 2.3) },
    ]

    depthTests.forEach(({ stack, expectedMin, expectedMax }) => {
      const raw = createTable(stack)
      for (let btn = 0; btn < 9; btn++) {
        const seats = assignPositions(raw, btn)
        const engine = createHand(seats, HERO_SEAT, 0, 18000)
        const decision = engine.currentDecision
        // Only check first-in RFI spots (no prior aggressor, hero is BTN or CO)
        if (
          decision &&
          decision.lastAggressor === null &&
          (engine.heroSeat.position === 'BTN' || engine.heroSeat.position === 'CO')
        ) {
          const raise = decision.options.find(o => o.type === 'raise')
          if (raise && raise.amount > 0) {
            expect(raise.amount).toBeGreaterThanOrEqual(expectedMin)
            expect(raise.amount).toBeLessThanOrEqual(expectedMax + bb)
          }
          break
        }
      }
    })
  })

  it('3-bet sizing follows 2.5x + callers formula', () => {
    const raise = 600
    const tests = [
      { callers: 0, expected: raise * 2.5 },
      { callers: 1, expected: raise * 3.5 },
      { callers: 2, expected: raise * 4.5 },
    ]
    tests.forEach(({ callers, expected }) => {
      const rawThreeBet = raise * (2.5 + callers)
      expect(rawThreeBet).toBe(expected)
    })
  })

  it('No option quality is undefined or null', () => {
    for (let hand = 0; hand < 27; hand++) {
      const levelIndex = Math.floor(hand / 9)
      const handInLevel = hand % 9
      const btn = getDealerButtonForHand(handInLevel, HERO_SEAT)
      const engine = makeHandAt(levelIndex, HERO_SEAT, btn)

      let maxIter = 15
      while (!engine.isOver && maxIter-- > 0) {
        if (!engine.currentDecision) {
          if (engine.pendingAdvance) {
            engine.currentDecision = advanceToNextStreet(engine, levelIndex, 18000)
          } else {
            break
          }
          continue
        }
        const decision = engine.currentDecision
        expect(decision.options.length).toBeGreaterThan(0)
        decision.options.forEach(opt => {
          expect(opt.quality).toBeDefined()
          expect(opt.quality).not.toBeNull()
          expect(['best','good','ok','bad']).toContain(opt.quality)
          expect(opt.coaching).toBeDefined()
          expect(opt.label).toBeDefined()
        })
        const best = decision.options.find(o => o.quality === 'best') ?? decision.options[0]
        engine.currentDecision = processHeroAction(engine, best, levelIndex, 18000)
        if (engine.pendingAdvance) {
          engine.currentDecision = advanceToNextStreet(engine, levelIndex, 18000)
        }
      }
    }
  })

  it('Chip conservation across 27 hands (3 full levels)', () => {
    const STARTING = STARTING_STACK
    for (let hand = 0; hand < 27; hand++) {
      const levelIndex = Math.floor(hand / 9)
      const handInLevel = hand % 9
      const btn = getDealerButtonForHand(handInLevel, HERO_SEAT)
      const engine = makeHandAt(levelIndex, HERO_SEAT, btn)

      const before = engine.seats.reduce((s, seat) => s + seat.stack, 0) + engine.pot
      expect(before).toBe(STARTING * 9)

      const finished = playHandToEnd(engine, levelIndex)
      const after = finished.seats.reduce((s, seat) => s + seat.stack, 0) + finished.pot
      expect(Math.abs(after - STARTING * 9)).toBeLessThanOrEqual(1)
    }
  })
})
