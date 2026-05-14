export type Archetype = 'LP' | 'LA' | 'TP' | 'TA'

export interface ArchetypeProfile {
  label: string
  foldToRaise: number
  foldToBet: number
  raiseNuts: number
  description: string
}

export const ARCHETYPES: Record<Archetype, ArchetypeProfile> = {
  LP: {
    label: 'Loose-Passive',
    foldToRaise: 0.15,
    foldToBet: 0.10,
    raiseNuts: 0.45,
    description: 'Calls wide, rarely raises without nuts. Value bet relentlessly.',
  },
  LA: {
    label: 'Loose-Aggressive',
    foldToRaise: 0.35,
    foldToBet: 0.25,
    raiseNuts: 0.80,
    description: 'Bets when checked to, bluffs wide. Induce by checking.',
  },
  TP: {
    label: 'Tight-Passive',
    foldToRaise: 0.82,
    foldToBet: 0.68,
    raiseNuts: 0.55,
    description: 'Folds to aggression. Steal blinds relentlessly.',
  },
  TA: {
    label: 'Tight-Aggressive',
    foldToRaise: 0.65,
    foldToBet: 0.50,
    raiseNuts: 0.88,
    description: 'Fold dominated hands. Apply pressure in position.',
  },
}

export interface HandStrength {
  str: number       // 0=air, 1=pair, 2=twopair, 3=set, 4=straight, 5=flush, 6=boat, 7=quads
  label: string
  pairPos: string   // 'toppair' | 'overpair' | 'secondpair' | 'bottompair' | 'underpair' | 'set' | 'flush' | etc.
  heroFD: boolean
  oesd: boolean
  gut: boolean
}

export type VillainActionResult = 'fold' | 'call' | 'raise' | 'check' | 'win'

export interface VillainDecision {
  action: VillainActionResult
  label: string
  why: string
}

export function villainDecision(
  hs: HandStrength,
  heroAction: string,
  arch: Archetype = 'TA'
): VillainDecision | null {
  // Never call when hero folds — no villain decision needed
  if (heroAction === 'fold') return null

  const A = ARCHETYPES[arch]
  const { str, label, pairPos } = hs

  const isNuts    = str >= 6
  const isStrong  = str >= 4 || str === 3
  const isTwoPair = str === 2
  const isTop     = str === 1 && (pairPos === 'toppair' || pairPos === 'overpair')
  const isSecond  = str === 1 && pairPos === 'secondpair'
  const isWeak    = str === 0 || (str === 1 && (pairPos === 'bottompair' || pairPos === 'underpair'))

  const isBig  = heroAction === 'shove' || heroAction === 'raise-large'
  const isMed  = heroAction === 'raise' || heroAction === 'bet'
  const isCheck = heroAction === 'check'

  if (isCheck) {
    return { action: 'check', label: 'Checks back', why: `${A.label} takes the free card with ${label}.` }
  }

  if (isNuts) {
    if (Math.random() < A.raiseNuts) {
      return { action: 'raise', label: 'Raises', why: `${label} — raises for maximum value.` }
    }
    return { action: 'call', label: 'Calls', why: `${label} — slow-plays the nuts.` }
  }

  if (isStrong || isTwoPair) {
    if (isBig && arch === 'TP') {
      return { action: 'fold', label: 'Folds', why: `Tight-passive folds ${label.toLowerCase()} to large pressure.` }
    }
    return { action: 'call', label: 'Calls', why: `${label} — strong enough to continue.` }
  }

  if (isTop) {
    if (isBig && Math.random() < A.foldToRaise) {
      return { action: 'fold', label: 'Folds', why: `Top pair folds to large bet — suspects better hand.` }
    }
    return { action: 'call', label: 'Calls', why: `Top pair calls — villain believes they're ahead.` }
  }

  if (isSecond) {
    if (isBig) return { action: 'fold', label: 'Folds', why: `Second pair folds to large bet.` }
    if (isMed && Math.random() < A.foldToBet + 0.15) {
      return { action: 'fold', label: 'Folds', why: `Second pair can't continue facing real pressure.` }
    }
    return { action: 'call', label: 'Calls', why: `Second pair peels one street.` }
  }

  if (isWeak) {
    return { action: 'fold', label: 'Folds', why: `${label} — too weak to continue.` }
  }

  if (isBig) return { action: 'fold', label: 'Folds', why: `Folds to significant pressure.` }
  return { action: 'call', label: 'Calls', why: `Marginal continue.` }
}
