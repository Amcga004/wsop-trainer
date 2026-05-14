import type { HandState } from '../types'
import { getSB, getBB, getAnte } from './tournamentStructure'

// Initialize hand state — call at the start of every new hand
// heroPos: 'BTN' | 'SB' | 'BB' | 'CO' | etc.
export function initHand(
  levelIndex: number,
  heroPos: string,
  preflopPotOverride?: number
): HandState {
  const sb = getSB(levelIndex)
  const bb = getBB(levelIndex)
  const ante = getAnte(levelIndex)

  // How much has hero already posted before any decision?
  let heroPosted = 0
  if (heroPos === 'SB') heroPosted = sb
  if (heroPos === 'BB') heroPosted = bb + ante  // BB pays BB + BB ante

  // Base pot: SB + BB + BB_ante (all collected before any open raise)
  const basePot = sb + bb + ante

  return {
    pot: preflopPotOverride ?? basePot,
    heroContrib: heroPosted,
    heroPosted,
    villainContrib: 0,
    isResolved: false,
  }
}

// Hero takes an action that costs chips
// Returns updated HandState — never mutates input
export function heroActs(
  state: HandState,
  heroStack: number,
  nominalCost: number   // the amount shown on the button label
): { state: HandState; actualCost: number; newStack: number } {
  // Actual cost = nominal minus already posted this street
  // (posted is subtracted when we compute call cost per scenario)
  const actualCost = Math.min(nominalCost, heroStack)

  return {
    state: {
      ...state,
      pot: state.pot + actualCost,
      heroContrib: state.heroContrib + actualCost,
    },
    actualCost,
    newStack: heroStack - actualCost,
  }
}

// Villain responds — only add to pot if they call or raise
export function villainResponds(
  state: HandState,
  villainAction: 'fold' | 'call' | 'raise' | 'check',
  amount: number
): HandState {
  if (villainAction === 'fold' || villainAction === 'check') {
    return state  // pot doesn't change
  }
  return {
    ...state,
    pot: state.pot + amount,
    villainContrib: state.villainContrib + amount,
  }
}

// Hero wins the hand — returns chip gain (NOT including what hero invested)
// heroStack should NOT be modified yet when calling this
export function heroWins(state: HandState): number {
  // Hero gets the whole pot back, but they already "paid" heroContrib
  // Net gain = pot - what hero put in
  return state.pot - state.heroContrib
}

// Hero loses the hand (folded or lost at showdown)
// No additional deduction needed — chips were removed as bets were placed
export function heroLoses(): number {
  return 0
}

// Hero folds — they lose what they contributed but pot doesn't change further
// Returns their net loss for this hand (negative number)
export function heroFolds(state: HandState): number {
  return -state.heroContrib
}

// Apply hand result to hero's stack
// call this ONCE at hand resolution
export function resolveHand(
  heroStack: number,
  state: HandState,
  heroWon: boolean,
  heroFolded: boolean
): { newStack: number; chipDelta: number } {
  if (heroFolded) {
    // Stack was already decremented as hero posted/bet — no further change
    // chipDelta is the total we removed from stack during the hand
    return {
      newStack: heroStack,
      chipDelta: -state.heroContrib,
    }
  }

  if (heroWon) {
    const gain = heroWins(state)
    return {
      newStack: heroStack + gain,
      chipDelta: gain,
    }
  }

  // Lost at showdown — stack already decremented, no further change
  return {
    newStack: heroStack,
    chipDelta: -state.heroContrib,
  }
}

// Compute exact call cost for a given action, accounting for what hero posted
// Use this when building scenario action chipCost values
export function callCost(
  totalFacing: number,   // total amount hero must match
  alreadyPosted: number  // what hero already has in the pot this street
): number {
  return Math.max(0, totalFacing - alreadyPosted)
}

// Test helper — verify known hand
// BTN opens 500, BB calls. Flop: BB checks, BTN bets 800, BB calls.
// Turn: check/check. River: BTN bets 2200, BB folds.
// Expected: BTN invested 500+800+2200=3500. Pot = base(500+200+200) + 500 + 800*2 + 800 + 2200 = complex
// Simpler: pot starts 900, BTN raises to 500 total (adds 300 more) = 1200, BB calls (adds 300) = 1500 ...
// Use resolveHand to check BTN wins pot - contrib
export function testChipMath(): void {
  const li = 0  // Level 1: 100/200/200 ante
  // Hero is BTN, opens to 500
  let state = initHand(li, 'BTN')
  // Base pot = 100+200+200 = 500. Hero posts 0 (BTN).
  console.assert(state.pot === 500, `Base pot should be 500, got ${state.pot}`)
  console.assert(state.heroContrib === 0, `BTN hero posted should be 0`)

  // Hero raises to 500 (costs 500 from stack)
  const r1 = heroActs(state, 60000, 500)
  state = r1.state
  console.assert(r1.actualCost === 500, `Open cost should be 500`)
  console.assert(state.pot === 1000, `Pot after open should be 1000`)
  console.assert(state.heroContrib === 500, `Hero contrib should be 500`)

  // BB calls 300 more (already posted 400, faces 500 total, costs 100)
  state = villainResponds(state, 'call', 300)
  console.assert(state.pot === 1300, `Pot after BB call should be 1300`)

  // Flop: BB checks, hero bets 800
  const r2 = heroActs(state, 60000 - 500, 800)
  state = r2.state
  console.assert(state.pot === 2100, `Pot after flop bet should be 2100`)
  console.assert(state.heroContrib === 1300, `Hero contrib after flop bet should be 1300`)

  // BB calls 800
  state = villainResponds(state, 'call', 800)
  console.assert(state.pot === 2900, `Pot after BB flop call should be 2900`)

  // Turn: check/check — pot unchanged
  // River: hero bets 2200, BB folds
  const r3 = heroActs(state, 60000 - 1300, 2200)
  state = r3.state
  state = villainResponds(state, 'fold', 0)

  const result = resolveHand(60000 - 1300, state, true, false)
  // Hero invested 500+800+2200=3500. Pot = 2900+2200=5100. Win = 5100-3500 = 1600 net gain
  console.assert(result.chipDelta === 1600, `Net gain should be 1600, got ${result.chipDelta}`)
  console.log('chipMath tests passed')
}
