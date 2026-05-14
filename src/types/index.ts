// Quality of a decision
export type Quality = 'best' | 'good' | 'ok' | 'bad'
export const QSCORE: Record<Quality, number> = { best: 10, good: 7, ok: 4, bad: 0 }
export const QLABEL: Record<Quality, string> = { best: 'BEST', good: 'GOOD', ok: 'OKAY', bad: 'BAD' }

// Continue type after a decision resolves
export type ContinueType = 'next' | 'fold' | 'showdown'

// Session mode
export type SessionMode = 'full' | 'day1' | 'day2' | 'day3' | 'drill'

// Drill target
export type DrillType =
  | 'fp_draw_miss'
  | 'fp_overpair_ace'
  | 'fp_multiway'
  | 'ss_push_fold'
  | 'fp_cbet_dry'
  | 'fp_cbet_wet'
  | 'pf_vs_3bet'
  | 'pf_bb_defend'

// A single card
export interface Card { r: string; s: string }

// One action button in a scenario
export interface Action {
  label: string
  cls: string           // CSS class for color: a-fold a-call a-raise a-shove a-3bet a-check
  quality: Quality
  coaching: string
  chipCost: number      // exact chips hero pays — 0 for fold/check
  ct: ContinueType
}

// One street within a scenario
export interface Street {
  street: 'Preflop' | 'Flop' | 'Turn' | 'River'
  board: Card[]
  villainAction: string | null   // 'open' | 'bet' | 'check' | '3bet' | null
  desc: string
  actions: Action[]
}

// A complete scenario (one hand)
export interface Scenario {
  id: string
  scenarioType: DrillType | string
  heroPos: string
  heroCards: [Card, Card]
  handName: string
  preflopPot: number
  activeSeats: string[]
  villainHand: {
    r1: string; s1: string
    r2: string; s2: string
    name: string
    pos: string
    archetype: 'LP' | 'LA' | 'TP' | 'TA'
  } | null
  rangeKey: string | null
  heroEquity: number | null
  streets: Street[]
}

// Result of one decision
export interface DecisionRecord {
  scenarioType: string
  street: string
  heroPos: string
  quality: Quality
  points: number
  stackBefore: number
  stackAfter: number
  chipDelta: number
  actionLabel: string
  coaching: string
}

// Tournament session state
export interface TournamentState {
  mode: SessionMode
  drillType?: DrillType
  levelIndex: number      // 0-46
  handInLevel: number     // 0-6 (7 hands per level)
  totalHands: number
  heroStack: number
  playersLeft: number
  isItm: boolean
  decisions: DecisionRecord[]
  chipHistory: number[]   // stack snapshot after each level
}

// Chip math hand state
export interface HandState {
  pot: number
  heroContrib: number        // total chips hero has put in THIS hand
  heroPosted: number         // blind/ante already posted this hand
  villainContrib: number     // tracked but not used for hero math
  isResolved: boolean
}
