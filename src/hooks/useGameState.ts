'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  createHand, processHeroAction, advanceToNextStreet, createTable, assignPositions,
  type HandEngine, type HeroOption, type HeroDecision, type Seat,
} from '../engine/handEngine'
import { createTournament, endTournament } from '../lib/saveTournament'
import { saveDecision } from '../lib/saveDecision'
import {
  getBB, getSB, getAnte, getBBDepth, getDay,
  getPlayersLeft, STARTING_STACK, TOTAL_LEVELS,
  HANDS_PER_LEVEL, ITM_PLAYERS, isNearBubble, isItm,
  getDealerButtonForHand, DAY2_START_LEVEL, DAY3_START_LEVEL,
  getPlayersLeftAtLevelStart, randomPartition,
} from '../engine/tournamentStructure'
import { QSCORE, QLABEL, type Quality, type SessionMode, type DecisionRecord } from '../types'

const ACTIVE_SAVES_KEY = 'wsop_active_saves'
const COMPLETED_SAVES_KEY = 'wsop_completed_saves'
const DEVICE_KEY = 'wsop_device_id'

function getOrCreateDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) {
      const rand = Math.random().toString(36).substring(2, 10)
      const time = Date.now().toString(36)
      id = `${rand}-${time}`
      localStorage.setItem(DEVICE_KEY, id)
    }
    return id
  } catch { return 'unknown' }
}

// ─────────────────────────────────────────────────────────────
// SAVE TYPES
// ─────────────────────────────────────────────────────────────

export interface ActiveSave {
  id: string
  startedAt: number
  savedAt: number
  heroStack: number
  levelIndex: number
  totalHands: number
  sessionScore: number
  sessionMaxScore: number
  playersLeft: number
  heroSeatIndex: number
  dealerButton: number
  mode: string
  deviceId: string
  tableSeats: Array<{ seatIndex: number; stack: number; archetype: string }>
}

export interface CompletedSave {
  id: string
  startedAt: number
  endedAt: number
  result: 'bust' | 'win'
  finalLevel: number
  finalHand: number
  finalStack: number
  sessionScore: number
  sessionMaxScore: number
  mode: string
}

function getAllActiveSaves(): ActiveSave[] {
  try {
    const raw = localStorage.getItem(ACTIVE_SAVES_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ActiveSave[]
  } catch { return [] }
}

function getAllCompletedSaves(): CompletedSave[] {
  try {
    const raw = localStorage.getItem(COMPLETED_SAVES_KEY)
    if (!raw) return []
    return JSON.parse(raw) as CompletedSave[]
  } catch { return [] }
}

export function getActiveSaves(): ActiveSave[] {
  const deviceId = getOrCreateDeviceId()
  return getAllActiveSaves().filter(s => s.deviceId === deviceId)
}

export function getCompletedSaves(): CompletedSave[] {
  return getAllCompletedSaves()
}

function upsertActiveSave(save: ActiveSave): void {
  try {
    const all = getAllActiveSaves()
    const idx = all.findIndex(s => s.id === save.id)
    if (idx >= 0) all[idx] = save
    else all.unshift(save)
    localStorage.setItem(ACTIVE_SAVES_KEY, JSON.stringify(all))
  } catch {}
}

export function deleteActiveSave(id: string): void {
  try {
    const all = getAllActiveSaves().filter(s => s.id !== id)
    localStorage.setItem(ACTIVE_SAVES_KEY, JSON.stringify(all))
  } catch {}
}

function addCompletedSave(save: CompletedSave): void {
  try {
    const all = getAllCompletedSaves()
    all.unshift(save)
    localStorage.setItem(COMPLETED_SAVES_KEY, JSON.stringify(all.slice(0, 20)))
  } catch {}
}

export function deleteCompletedSave(id: string): void {
  try {
    const all = getAllCompletedSaves().filter(s => s.id !== id)
    localStorage.setItem(COMPLETED_SAVES_KEY, JSON.stringify(all))
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────

export type GamePhase =
  | 'lobby'
  | 'playing'
  | 'outcome'
  | 'villain_guess'
  | 'villain_reveal'
  | 'recap'
  | 'level_up'
  | 'day_break'
  | 'itm'
  | 'bust'
  | 'win'

export interface StreetResult {
  street:      string
  board:       { r: string; s: string }[]
  heroAction:  HeroOption
  chipDelta:   number
  preDesc:     string
  postDesc:    string
}

export interface GameState {
  phase:            GamePhase
  mode:             SessionMode
  tournamentId:     string | null
  startedAt:        number

  // Tournament progression
  levelIndex:       number
  handInLevel:      number
  totalHands:       number
  playersLeft:      number
  isItm:            boolean

  // Table state (persists across hands)
  tableSeats:       Omit<Seat, 'position'>[]
  dealerButton:     number   // which seat index is BTN
  heroSeatIndex:    number   // always 4

  // Current hand engine (null between hands)
  engine:           HandEngine | null

  // Hand history for recap
  streetResults:    StreetResult[]
  heroStackBefore:  number   // stack at start of hand

  // Last decision outcome (for outcome phase)
  lastOption:       HeroOption | null
  lastChipDelta:    number
  lastDecision:     HeroDecision | null

  // Villain guess state
  guessOptions:     string[]   // 6 hand strings to guess from
  guessCorrect:     string     // the actual villain hand string

  // Scoring
  sessionScore:     number
  sessionMaxScore:  number
  sessionDecisions: DecisionRecord[]

  // Chip history for graph
  chipHistory:      number[]
  heroStack:        number

  // Hand-by-hand field reduction (ITM / near-bubble)
  handEliminations:      number[]  // [9] per-hand eliminations for current level
  justMadeMoney:         boolean
  justReachedFinalTable: boolean
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function r500(n: number): number { return Math.round(n / 500) * 500 }

function generateHandEliminations(levelIndex: number, currentPlayersLeft: number): number[] {
  const playersAtEnd = getPlayersLeftAtLevelStart(levelIndex + 1)
  const total = Math.max(0, currentPlayersLeft - playersAtEnd)
  return randomPartition(total, HANDS_PER_LEVEL)
}

function getStartingStack(mode: SessionMode, levelIndex: number): number {
  const bb = getBB(levelIndex)
  switch (mode) {
    case 'day2': return r500(bb * 50)
    case 'day3': return r500(bb * 30)
    default:     return STARTING_STACK
  }
}

function getVillainStack(mode: SessionMode, levelIndex: number): number {
  const bb = getBB(levelIndex)
  switch (mode) {
    case 'day2': {
      const randomBB = 10 + Math.random() * 90   // 10–100BB
      return r500(bb * randomBB)
    }
    case 'day3': {
      const randomBB = 8 + Math.random() * 42    // 8–50BB
      return r500(bb * randomBB)
    }
    default:
      return STARTING_STACK
  }
}

function makeInitialState(mode: SessionMode): GameState {
  const startLevel = mode === 'day2' ? DAY2_START_LEVEL : mode === 'day3' ? DAY3_START_LEVEL : 0
  const heroStack  = getStartingStack(mode, startLevel)
  const rawSeats   = createTable(heroStack)
  const heroSeatIndex = 4
  const tableSeats = rawSeats.map((seat, i) => ({
    ...seat,
    stack: i === heroSeatIndex ? heroStack : getVillainStack(mode, startLevel),
  }))
  const startingPlayersLeft = getPlayersLeftAtLevelStart(startLevel)
  const startingHandElims = startingPlayersLeft <= ITM_PLAYERS + 500
    ? generateHandEliminations(startLevel, startingPlayersLeft)
    : Array(HANDS_PER_LEVEL).fill(0)
  return {
    phase:            'lobby',
    mode,
    tournamentId:     null,
    startedAt:        0,
    levelIndex:       startLevel,
    handInLevel:      0,
    totalHands:       0,
    playersLeft:      startingPlayersLeft,
    isItm:            false,
    tableSeats,
    dealerButton:     0,
    heroSeatIndex,
    engine:           null,
    streetResults:    [],
    heroStackBefore:  heroStack,
    lastOption:       null,
    lastChipDelta:    0,
    lastDecision:     null,
    guessOptions:     [],
    guessCorrect:     '',
    sessionScore:     0,
    sessionMaxScore:  0,
    sessionDecisions: [],
    chipHistory:      [heroStack],
    heroStack,
    handEliminations:      startingHandElims,
    justMadeMoney:         false,
    justReachedFinalTable: false,
  }
}

const RANK_ORDER = ['A','K','Q','J','T','9','8','7','6','5','4','3','2']

function toHandNotation(c1r: string, c2r: string, suited: boolean): string {
  const i1 = RANK_ORDER.indexOf(c1r)
  const i2 = RANK_ORDER.indexOf(c2r)
  const [hi, lo] = i1 <= i2 ? [c1r, c2r] : [c2r, c1r]
  if (hi === lo) return `${hi}${lo}`
  return `${hi}${lo}${suited ? 's' : 'o'}`
}

const HAND_TIERS = {
  premium:    ['AA','KK','QQ','JJ','AKs','AKo'],
  strong:     ['TT','99','AQs','AJs','KQs','AQo'],
  medium:     ['88','77','ATs','A9s','KJs','KTs','QJs','JTs','AJo','KQo'],
  speculative:['66','55','44','A8s','A7s','A5s','A4s','KJo','QJo','T9s','98s','87s','76s'],
  bluff:      ['33','22','A3s','A2s','K9s','Q9s','J9s','T8s','97s','86s','75s','65s','54s'],
}

function buildGuessOptions(engine: HandEngine): { options: string[]; correct: string } {
  const villain = engine.showdownSeat
  if (!villain?.holeCards) return { options: [], correct: '' }

  const [c1, c2] = villain.holeCards
  const correct = toHandNotation(c1.r, c2.r, c1.s === c2.s)

  const vs = engine.primaryVillain?.rangeStrength ?? 5

  // Determine which tiers are likely based on villain range strength
  const likelyPool   = vs >= 8 ? [...HAND_TIERS.premium, ...HAND_TIERS.strong]
                     : vs >= 6 ? [...HAND_TIERS.strong, ...HAND_TIERS.medium]
                     : vs >= 4 ? [...HAND_TIERS.medium, ...HAND_TIERS.speculative]
                     : [...HAND_TIERS.speculative, ...HAND_TIERS.bluff]
  const possiblePool = vs >= 6 ? [...HAND_TIERS.medium]
                     : [...HAND_TIERS.strong, ...HAND_TIERS.medium]
  const unlikelyPool = vs >= 6 ? [...HAND_TIERS.speculative, ...HAND_TIERS.bluff]
                     : [...HAND_TIERS.premium, ...HAND_TIERS.bluff]

  function pickFrom(pool: string[], exclude: string[], n: number): string[] {
    return pool.filter(h => !exclude.includes(h)).sort(() => Math.random() - 0.5).slice(0, n)
  }

  const chosen: string[] = [correct]
  chosen.push(...pickFrom(likelyPool, chosen, 2))
  chosen.push(...pickFrom(possiblePool, chosen, 2))
  chosen.push(...pickFrom(unlikelyPool, chosen, 1))

  // Pad to 6 with fallback if pools were too small
  const fallback = ['AKo','QJs','TT','87s','AQs','KK','99','JTs','A5s','66','AJo','KQo']
  while (chosen.length < 6) {
    const fb = fallback.find(h => !chosen.includes(h))
    if (fb) chosen.push(fb)
    else break
  }

  // Shuffle
  const shuffled = chosen.slice(0, 6)
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  return { options: shuffled, correct }
}

function isTrivialFold(engine: HandEngine): boolean {
  const decision = engine.currentDecision
  if (!decision || decision.street !== 'preflop') return false
  const onlyFold = decision.options.length <= 2 &&
    decision.options.every(o => o.quality === 'best' || o.type === 'fold')
  const earlyPos = ['UTG', 'UTG1', 'UTG2'].includes(decision.heroPos)
  const noAction = decision.activePlayers <= 2
  return onlyFold && earlyPos && noAction
}

// ─────────────────────────────────────────────────────────────
// HOOK
// ─────────────────────────────────────────────────────────────

export function useGameState(initialMode: SessionMode = 'full') {
  const [state, setState] = useState<GameState>(() => makeInitialState(initialMode))
  const stateRef = useRef(state)
  stateRef.current = state

  // ── Start tournament ──────────────────────────────────────
  const startTournament = useCallback(async (mode: SessionMode) => {
    const tournamentId = await createTournament(mode)
    setState(prev => {
      const fresh = makeInitialState(mode)
      const btn = getDealerButtonForHand(0, fresh.heroSeatIndex)
      const finalEngine = createHand(assignPositions(fresh.tableSeats, btn), fresh.heroSeatIndex, fresh.levelIndex, fresh.playersLeft)
      const stackBefore = finalEngine.heroSeat.stack
      if (finalEngine.isOver) {
        finalEngine.heroSeat.stack += finalEngine.pot
        finalEngine.pot = 0
      }
      return {
        ...fresh,
        phase:        finalEngine.isOver ? 'recap' : 'playing',
        tournamentId,
        startedAt:    Date.now(),
        dealerButton: btn,
        engine:       finalEngine,
        heroStack:    finalEngine.heroSeat.stack,
        heroStackBefore: stackBefore,
      }
    })
  }, [])

  // ── Hero takes an action ──────────────────────────────────
  const takeAction = useCallback((optionIndex: number) => {
    setState(prev => {
      if (!prev.engine || prev.phase !== 'playing') return prev
      const decision = prev.engine.currentDecision
      if (!decision) return prev

      const option = decision.options[optionIndex]
      const savedDecision = { ...decision, options: [...decision.options] }
      const points = QSCORE[option.quality]
      const stackBefore = prev.heroStack
      // chipDelta = net additional chips committed this action
      // Fold costs 0 additional — chips already bet were already tracked
      const chipDelta = -option.chipCost

      // Record decision for DB
      const decisionRecord: DecisionRecord = {
        scenarioType: `${decision.street}_${option.type}`,
        street:       decision.street,
        heroPos:      decision.heroPos,
        quality:      option.quality,
        points,
        stackBefore,
        stackAfter:   stackBefore + chipDelta,
        chipDelta,
        actionLabel:  option.label,
        coaching:     option.coaching,
      }

      // Process action through engine
      const newEngine = {
        ...prev.engine,
        board:       [...(prev.engine?.board ?? [])],
        handLog:     [...(prev.engine?.handLog ?? [])],
        streetLog:   [...(prev.engine?.streetLog ?? [])],
        activeSeats: [...(prev.engine?.activeSeats ?? [])],
        seats:       (prev.engine?.seats ?? []).map(s => ({ ...s })),
        heroSeat:    { ...(prev.engine?.heroSeat ?? {}) } as typeof prev.engine.heroSeat,
      }
      const nextDecision = processHeroAction(newEngine, option, prev.levelIndex, prev.playersLeft)
      newEngine.currentDecision = nextDecision

      // Record street result (after engine so postDesc is available)
      const streetResult: StreetResult = {
        street:    decision.street,
        board:     [...decision.board],
        heroAction: option,
        chipDelta,
        preDesc:   savedDecision?.desc ?? '',
        postDesc:  newEngine.pendingStreetDesc ?? '',
      }

      const newScore    = prev.sessionScore + points
      const newMaxScore = prev.sessionMaxScore + 10
      const newResults  = [...prev.streetResults, streetResult]
      const newDecisions = [...prev.sessionDecisions, decisionRecord]

      // Fire-and-forget per-action save
      if (typeof window !== 'undefined' && prev.tournamentId) {
        saveDecision({
          tournamentId: prev.tournamentId,
          street:       decision.street,
          heroPos:      decision.heroPos,
          action:       option.label,
          quality:      option.quality,
          pot:          decision.pot,
          chipCost:     option.chipCost,
          levelIndex:   prev.levelIndex,
          playersLeft:  prev.playersLeft,
        }).catch(() => {})
      }

      // Determine next phase
      let nextPhase: GamePhase = 'outcome'
      let guessOptions: string[] = []
      let guessCorrect = ''

      // If hand is over — resolve chips
      let resolvedChipDelta = chipDelta
      if (newEngine.isOver) {
        const heroInvested = newEngine.heroSeat.invested
        const totalPot = newEngine.pot

        if (totalPot === 0) {
          // resolveShowdown ran inside the engine — chips already applied
          resolvedChipDelta = newEngine.heroSeat.stack - stackBefore
        } else if (newEngine.heroWon && !newEngine.isTie) {
          // Hero wins entire pot (fold win)
          newEngine.heroSeat.stack += totalPot
          resolvedChipDelta = totalPot - heroInvested
          newEngine.pot = 0
        } else if (newEngine.isTie) {
          // Chop — split pot
          const heroShare = Math.floor(totalPot / 2)
          const villainShare = totalPot - heroShare
          newEngine.heroSeat.stack += heroShare
          const tieVillain = newEngine.showdownSeat
          if (tieVillain) {
            const vs = newEngine.seats.find(s => s.seatIndex === tieVillain.seatIndex)
            if (vs) vs.stack += villainShare
          }
          resolvedChipDelta = heroShare - heroInvested
          newEngine.pot = 0
        } else {
          // Villain wins (fold loss)
          const winner = newEngine.showdownSeat
            ?? newEngine.activeSeats.find(
                s => s.seatIndex !== newEngine.heroSeat.seatIndex && !s.folded
              )
          if (winner) {
            const ws = newEngine.seats.find(s => s.seatIndex === winner.seatIndex)
            if (ws) ws.stack += totalPot
            resolvedChipDelta = -heroInvested
          } else {
            resolvedChipDelta = -heroInvested
          }
          newEngine.pot = 0
        }

        // If went to showdown — show guess screen
        if (newEngine.showdownSeat) {
          const guess = buildGuessOptions(newEngine)
          if (guess.options.length > 0) {
            guessOptions = guess.options
            guessCorrect = guess.correct
          }
          nextPhase = 'outcome' // show coaching first, then continue to guess
        }
      }

      return {
        ...prev,
        engine:           newEngine,
        heroStack:        newEngine.heroSeat.stack,
        streetResults:    newResults,
        sessionScore:     newScore,
        sessionMaxScore:  newMaxScore,
        sessionDecisions: newDecisions,
        lastOption:       option,
        lastDecision:     savedDecision,
        lastChipDelta:    resolvedChipDelta,
        phase:            nextPhase,
        guessOptions,
        guessCorrect,
      }
    })
  }, [])

  // ── Continue after outcome screen ─────────────────────────
  const continueAfterOutcome = useCallback(() => {
    setState(prev => {
      if (!prev.engine) return prev

      // Pending street advance — deal next card(s)
      if (prev.engine.pendingAdvance) {
        const engineClone: HandEngine = {
          ...prev.engine,
          board:       [...prev.engine.board],
          handLog:     [...prev.engine.handLog],
          streetLog:   [...prev.engine.streetLog],
          activeSeats: [...prev.engine.activeSeats],
          seats:       prev.engine.seats.map(s => ({ ...s })),
          heroSeat:    { ...prev.engine.heroSeat },
        }
        const nextDecision = advanceToNextStreet(engineClone, prev.levelIndex, prev.playersLeft)
        engineClone.currentDecision = nextDecision

        // Chip resolution if hand ended during advance
        if (engineClone.isOver) {
          const totalPot = engineClone.pot
          if (totalPot > 0) {
            // resolveShowdown was NOT called (fold case) — apply chips here
            if (engineClone.heroWon && !engineClone.isTie) {
              engineClone.heroSeat.stack += totalPot
            } else if (engineClone.isTie) {
              const heroShare = Math.floor(totalPot / 2)
              const villainShare = totalPot - heroShare
              engineClone.heroSeat.stack += heroShare
              const tieVillain = engineClone.showdownSeat
              if (tieVillain) {
                const vs = engineClone.seats.find(s => s.seatIndex === tieVillain.seatIndex)
                if (vs) vs.stack += villainShare
              }
            } else {
              const winner = engineClone.showdownSeat
                ?? engineClone.activeSeats.find(
                    s => s.seatIndex !== engineClone.heroSeat.seatIndex && !s.folded
                  )
              if (winner) {
                const ws = engineClone.seats.find(s => s.seatIndex === winner.seatIndex)
                if (ws) ws.stack += totalPot
              }
            }
            engineClone.pot = 0
          }
          // If totalPot === 0, resolveShowdown already ran — stack is already correct
        }

        let nextPhase: GamePhase = nextDecision ? 'playing' : 'outcome'
        let guessOptions: string[] = prev.guessOptions
        let guessCorrect = prev.guessCorrect
        if (!nextDecision && engineClone.showdownSeat) {
          const guess = buildGuessOptions(engineClone)
          guessOptions = guess.options
          guessCorrect = guess.correct
        }

        return {
          ...prev,
          engine:      engineClone,
          heroStack:   engineClone.heroSeat.stack,
          guessOptions,
          guessCorrect,
          phase:       nextPhase,
        }
      }

      // Hand still going — next street decision ready
      if (!prev.engine.isOver && prev.engine.currentDecision) {
        return { ...prev, phase: 'playing' }
      }

      // Hand is over
      if (prev.engine.isOver) {
        // Showdown — go to guess
        if (prev.guessOptions.length > 0) {
          return { ...prev, phase: 'villain_guess' }
        }
        // No showdown — go to recap
        return { ...prev, phase: 'recap' }
      }

      return { ...prev, phase: 'recap' }
    })
  }, [])

  // ── Villain guess ─────────────────────────────────────────
  const submitGuess = useCallback((guess: string) => {
    setState(prev => ({ ...prev, phase: 'villain_reveal' }))
  }, [])

  // ── Next hand ─────────────────────────────────────────────
  const nextHand = useCallback(() => {
    setState(prev => {
      if (!prev.engine) return prev

      const newTotalHands  = prev.totalHands + 1
      const newHandInLevel = prev.handInLevel + 1
      const heroStack      = prev.heroStack

      // Compute newPlayersLeft — hand-by-hand when near bubble / ITM,
      // steady within level otherwise (jumps at level boundaries below)
      let newPlayersLeft: number
      if (prev.playersLeft <= ITM_PLAYERS + 500) {
        const elim = prev.handEliminations[prev.handInLevel] ?? 0
        newPlayersLeft = Math.max(1, prev.playersLeft - elim)
      } else {
        newPlayersLeft = prev.playersLeft
      }

      const justMadeMoney         = !prev.isItm && newPlayersLeft <= ITM_PLAYERS
      const justReachedFinalTable = prev.playersLeft > 9 && newPlayersLeft <= 9

      // Save decisions to DB
      if (prev.tournamentId) {
        prev.sessionDecisions.slice(-prev.streetResults.length).forEach(d =>
          saveDecision({
            tournamentId:  prev.tournamentId,
            handNumber:    newTotalHands,
            levelIndex:    prev.levelIndex,
            scenarioType:  d.scenarioType,
            street:        d.street,
            heroPos:       d.heroPos,
            action:        d.actionLabel,
            quality:       d.quality,
            points:        d.points,
            stackBefore:   d.stackBefore,
            stackAfter:    d.stackAfter,
            chipDelta:     d.chipDelta,
            coaching:      d.coaching,
          })
        )
      }

      // Bust check
      if (heroStack < getBB(prev.levelIndex)) {
        return { ...prev, phase: 'bust', playersLeft: newPlayersLeft }
      }

      // ITM check — first time entering the money
      if (!prev.isItm && isItm(newPlayersLeft)) {
        return {
          ...prev,
          totalHands:            newTotalHands,
          handInLevel:           newHandInLevel,
          playersLeft:           newPlayersLeft,
          isItm:                 true,
          justMadeMoney:         true,
          justReachedFinalTable: false,
          phase:                 'itm',
        }
      }

      // Level up check
      if (newHandInLevel >= HANDS_PER_LEVEL) {
        const newLevelIndex = prev.levelIndex + 1
        // At level boundary, use authoritative curve value
        const levelPlayersLeft = getPlayersLeftAtLevelStart(newLevelIndex)
        const newHandElims = levelPlayersLeft <= ITM_PLAYERS + 500
          ? generateHandEliminations(newLevelIndex, levelPlayersLeft)
          : Array(HANDS_PER_LEVEL).fill(0) as number[]
        if (newLevelIndex >= TOTAL_LEVELS) {
          return {
            ...prev,
            totalHands:            newTotalHands,
            handInLevel:           0,
            levelIndex:            newLevelIndex,
            playersLeft:           levelPlayersLeft,
            handEliminations:      newHandElims,
            chipHistory:           [...prev.chipHistory, heroStack],
            justMadeMoney:         false,
            justReachedFinalTable,
            phase:                 'win',
          }
        }
        const isDayBreak = getDay(newLevelIndex) !== getDay(prev.levelIndex)
        return {
          ...prev,
          totalHands:            newTotalHands,
          handInLevel:           0,
          levelIndex:            newLevelIndex,
          playersLeft:           levelPlayersLeft,
          handEliminations:      newHandElims,
          chipHistory:           [...prev.chipHistory, heroStack],
          justMadeMoney:         false,
          justReachedFinalTable,
          phase:                 isDayBreak ? 'day_break' : 'level_up',
        }
      }

      // Advance dealer button deterministically through all 9 positions
      const levelHandIndex = newTotalHands % HANDS_PER_LEVEL
      const newDealerButton = getDealerButtonForHand(levelHandIndex, prev.heroSeatIndex)

      // ── VILLAIN STACK VARIATION ──────────────────────────────
      // Zero-sum chip movement between villains; busted villains
      // replaced by new players from the tournament field.
      // Hero stack is never touched by this logic.
      const bb  = getBB(prev.levelIndex)
      const r100v = (n: number) => Math.round(n / 100) * 100
      const minStack = r100v(bb * 3)   // minimum to stay seated
      const minNew   = r100v(bb * 10)  // minimum new-player stack

      // Seed from actual engine stacks after the hand
      const villainStacks = new Map<number, number>()
      prev.engine!.seats.forEach(seat => {
        if (seat.seatIndex === prev.heroSeatIndex) return
        villainStacks.set(seat.seatIndex, Math.max(minStack, seat.stack))
      })

      // Simulate 1–3 inter-hand chip transfers between villains
      const vIdxs = [...villainStacks.keys()]
      const numEvents = Math.floor(Math.random() * 3) + 1
      for (let e = 0; e < numEvents; e++) {
        if (vIdxs.length < 2) break
        const i1 = Math.floor(Math.random() * vIdxs.length)
        let i2 = Math.floor(Math.random() * vIdxs.length)
        while (i2 === i1) i2 = Math.floor(Math.random() * vIdxs.length)
        const s1 = vIdxs[i1]; const s2 = vIdxs[i2]
        const st1 = villainStacks.get(s1)!
        const st2 = villainStacks.get(s2)!
        const transfer = r100v(Math.min(st1, st2) * (0.05 + Math.random() * 0.35))
        if (Math.random() < 0.5) {
          villainStacks.set(s1, Math.max(minStack, st1 - transfer))
          villainStacks.set(s2, st2 + transfer)
        } else {
          villainStacks.set(s2, Math.max(minStack, st2 - transfer))
          villainStacks.set(s1, st1 + transfer)
        }
      }

      // Replace busted villains with new tournament entrants
      const maxStack = Math.max(heroStack, ...villainStacks.values())
      const maxNew   = r100v(maxStack * 1.1)
      villainStacks.forEach((stack, seatIdx) => {
        if (stack <= minStack) {
          villainStacks.set(seatIdx, r100v(minNew + Math.random() * (maxNew - minNew)))
        }
      })

      const updatedTableSeats = prev.tableSeats.map((seat, i) => {
        if (i === prev.heroSeatIndex) return { ...seat, stack: heroStack }
        const newStack = villainStacks.get(i)
        return newStack !== undefined ? { ...seat, stack: newStack } : seat
      })

      const btn = newDealerButton
      const finalEngine = createHand(assignPositions(updatedTableSeats, btn), prev.heroSeatIndex, prev.levelIndex, newPlayersLeft)
      const stackBefore2 = finalEngine.heroSeat.stack
      if (finalEngine.isOver) {
        finalEngine.heroSeat.stack += finalEngine.pot
        finalEngine.pot = 0
      }

      return {
        ...prev,
        engine:                finalEngine,
        tableSeats:            updatedTableSeats,
        dealerButton:          btn,
        totalHands:            newTotalHands,
        handInLevel:           newHandInLevel,
        playersLeft:           newPlayersLeft,
        heroStack:             finalEngine.heroSeat.stack,
        heroStackBefore:       stackBefore2,
        streetResults:         [],
        lastOption:            null,
        lastChipDelta:         0,
        guessOptions:          [],
        guessCorrect:          '',
        justMadeMoney:         false,
        justReachedFinalTable,
        phase:                 finalEngine.isOver ? 'recap' : 'playing',
      }
    })
  }, [])

  // ── Continue after level up / day break / ITM ─────────────
  const continueTournament = useCallback(() => {
    setState(prev => {
      const updatedTableSeats = prev.tableSeats.map((seat, i) =>
        i === prev.heroSeatIndex ? { ...seat, stack: prev.heroStack } : seat
      )
      let btn = (prev.dealerButton + 1) % 9
      let finalEngine = createHand(assignPositions(updatedTableSeats, btn), prev.heroSeatIndex, prev.levelIndex, prev.playersLeft)
      let attempts = 0
      while (isTrivialFold(finalEngine) && attempts < 3) {
        attempts++
        btn = (btn + 1) % 9
        finalEngine = createHand(assignPositions(updatedTableSeats, btn), prev.heroSeatIndex, prev.levelIndex, prev.playersLeft)
      }
      const stackBefore3 = finalEngine.heroSeat.stack
      if (finalEngine.isOver) {
        finalEngine.heroSeat.stack += finalEngine.pot
        finalEngine.pot = 0
      }
      return {
        ...prev,
        engine:                finalEngine,
        tableSeats:            updatedTableSeats,
        dealerButton:          btn,
        heroStack:             finalEngine.heroSeat.stack,
        heroStackBefore:       stackBefore3,
        streetResults:         [],
        lastOption:            null,
        justMadeMoney:         false,
        justReachedFinalTable: false,
        phase:                 finalEngine.isOver ? 'recap' : 'playing',
      }
    })
  }, [])

  // ── Finalize tournament ───────────────────────────────────
  const finalizeTournament = useCallback(async (cashed: boolean) => {
    const s = stateRef.current
    if (!s.tournamentId) return
    deleteActiveSave(s.tournamentId)
    addCompletedSave({
      id:             s.tournamentId,
      startedAt:      s.startedAt,
      endedAt:        Date.now(),
      result:         cashed ? 'win' : 'bust',
      finalLevel:     s.levelIndex,
      finalHand:      s.totalHands,
      finalStack:     s.heroStack,
      sessionScore:   s.sessionScore,
      sessionMaxScore: s.sessionMaxScore,
      mode:           s.mode ?? 'full',
    })
    await endTournament(
      s.tournamentId, s.heroStack, s.levelIndex,
      s.sessionScore, s.sessionMaxScore,
      s.sessionDecisions.length, cashed,
      getDay(s.levelIndex), s.levelIndex, s.playersLeft,
    )
  }, [])

  // ── Manual save (from menu) ───────────────────────────────
  const saveTournament = useCallback(() => {
    const s = stateRef.current
    if (!s.tournamentId) return
    if (s.phase !== 'playing' && s.phase !== 'recap') return
    upsertActiveSave({
      id:             s.tournamentId,
      startedAt:      s.startedAt,
      savedAt:        Date.now(),
      heroStack:      s.heroStack,
      levelIndex:     s.levelIndex,
      totalHands:     s.totalHands,
      sessionScore:   s.sessionScore,
      sessionMaxScore: s.sessionMaxScore,
      playersLeft:    s.playersLeft,
      heroSeatIndex:  s.heroSeatIndex,
      dealerButton:   s.dealerButton,
      mode:           s.mode ?? 'full',
      deviceId:       getOrCreateDeviceId(),
      tableSeats:     s.tableSeats.map(seat => ({
        seatIndex: seat.seatIndex,
        stack:     seat.stack,
        archetype: seat.archetype,
      })),
    })
  }, [])

  // ── Resume from saved game ────────────────────────────────
  const resumeTournament = useCallback((save: ActiveSave) => {
    try {
      const newDealerButton = getDealerButtonForHand(
        save.totalHands % HANDS_PER_LEVEL,
        save.heroSeatIndex
      )
      const rawSeats = createTable(save.heroStack)
      const seats = assignPositions(rawSeats, newDealerButton)
      const seatsWithStacks = seats.map((seat, i) => {
        if (i === save.heroSeatIndex) return { ...seat, stack: save.heroStack }
        const saved = save.tableSeats?.find(s => s.seatIndex === i)
        return { ...seat, stack: saved?.stack ?? save.heroStack }
      })
      const engine = createHand(seatsWithStacks, save.heroSeatIndex, save.levelIndex, save.playersLeft)
      setState(() => ({
        ...makeInitialState((save.mode as SessionMode) ?? 'full'),
        engine,
        tournamentId:    save.id,
        startedAt:       save.startedAt,
        heroStack:       save.heroStack,
        levelIndex:      save.levelIndex,
        playersLeft:     save.playersLeft,
        totalHands:      save.totalHands,
        sessionScore:    save.sessionScore,
        sessionMaxScore: save.sessionMaxScore,
        dealerButton:    newDealerButton,
        heroSeatIndex:   save.heroSeatIndex,
        tableSeats:      seatsWithStacks,
        phase:           'playing',
        mode:            (save.mode as SessionMode) ?? 'full',
      }))
    } catch (e) {
      console.warn('Could not resume tournament', e)
    }
  }, [])

  // Auto-save after each hand completes
  useEffect(() => {
    if (state.phase === 'playing' || state.phase === 'recap') {
      if (!state.tournamentId) return
      upsertActiveSave({
        id:             state.tournamentId,
        startedAt:      state.startedAt,
        savedAt:        Date.now(),
        heroStack:      state.heroStack,
        levelIndex:     state.levelIndex,
        totalHands:     state.totalHands,
        sessionScore:   state.sessionScore,
        sessionMaxScore: state.sessionMaxScore,
        playersLeft:    state.playersLeft,
        heroSeatIndex:  state.heroSeatIndex,
        dealerButton:   state.dealerButton,
        mode:           state.mode ?? 'full',
        deviceId:       getOrCreateDeviceId(),
        tableSeats:     state.tableSeats.map(s => ({
          seatIndex: s.seatIndex,
          stack:     s.stack,
          archetype: s.archetype,
        })),
      })
    }
  }, [state.totalHands, state.phase])

  // ── Computed ──────────────────────────────────────────────
  const bb        = getBB(state.levelIndex)
  const sb        = getSB(state.levelIndex)
  const ante      = getAnte(state.levelIndex)
  const bbDepth   = getBBDepth(state.heroStack, state.levelIndex)
  const day       = getDay(state.levelIndex)
  const nearBubble = isNearBubble(state.playersLeft)
  const scorePct  = state.sessionMaxScore > 0
    ? Math.round(state.sessionScore / state.sessionMaxScore * 100) : 0

  return {
    state,
    startTournament,
    takeAction,
    continueAfterOutcome,
    submitGuess,
    nextHand,
    continueTournament,
    finalizeTournament,
    resumeTournament,
    saveTournament,
    getActiveSaves,
    getCompletedSaves,
    deleteActiveSave,
    deleteCompletedSave,
    bb, sb, ante, bbDepth, day, nearBubble, scorePct,
  }
}
