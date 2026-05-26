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
  getDealerButtonForHand,
} from '../engine/tournamentStructure'
import { QSCORE, QLABEL, type Quality, type SessionMode, type DecisionRecord } from '../types'

const SAVE_KEY = 'wsop_trainer_save'
const DEVICE_KEY = 'wsop_device_id'

function getOrCreateDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY)
    if (existing) return existing
    const id = [
      screen.width, screen.height,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      navigator.language,
      Math.random().toString(36).slice(2, 10),
    ].join('|')
    localStorage.setItem(DEVICE_KEY, id)
    return id
  } catch {
    return 'unknown'
  }
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
}

// ─────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────

function makeInitialState(mode: SessionMode): GameState {
  const startLevel = mode === 'day2' ? 22 : mode === 'day3' ? 39 : 0
  const tableSeats = createTable(STARTING_STACK)
  return {
    phase:            'lobby',
    mode,
    tournamentId:     null,
    levelIndex:       startLevel,
    handInLevel:      0,
    totalHands:       0,
    playersLeft:      getPlayersLeft(startLevel),
    isItm:            false,
    tableSeats,
    dealerButton:     0,
    heroSeatIndex:    4,
    engine:           null,
    streetResults:    [],
    heroStackBefore:  STARTING_STACK,
    lastOption:       null,
    lastChipDelta:    0,
    lastDecision:     null,
    guessOptions:     [],
    guessCorrect:     '',
    sessionScore:     0,
    sessionMaxScore:  0,
    sessionDecisions: [],
    chipHistory:      [STARTING_STACK],
    heroStack:        STARTING_STACK,
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

        if (newEngine.heroWon && !newEngine.isTie) {
          // Hero wins entire pot
          newEngine.heroSeat.stack += totalPot
          resolvedChipDelta = totalPot - heroInvested
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
        } else {
          // Villain wins
          const winner = newEngine.showdownSeat
            ?? newEngine.activeSeats.find(
                s => s.seatIndex !== newEngine.heroSeat.seatIndex && !s.folded
              )
          if (winner) {
            const ws = newEngine.seats.find(s => s.seatIndex === winner.seatIndex)
            const winnerInvested = ws?.invested ?? totalPot
            if (winner.allIn && winnerInvested < heroInvested) {
              // Side pot: villain all-in for less
              const mainPot = Math.min(winnerInvested * 2, totalPot)
              const sidePot = totalPot - mainPot
              if (ws) ws.stack += mainPot
              newEngine.heroSeat.stack += sidePot
              resolvedChipDelta = sidePot - heroInvested
            } else {
              if (ws) ws.stack += totalPot
              resolvedChipDelta = -heroInvested
            }
          } else {
            resolvedChipDelta = -heroInvested
          }
        }
        newEngine.pot = 0

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
      const newPlayersLeft = Math.max(1, getPlayersLeft(prev.levelIndex))
      const heroStack      = prev.heroStack

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

      // ITM check
      if (!prev.isItm && isItm(newPlayersLeft)) {
        return {
          ...prev,
          totalHands:  newTotalHands,
          handInLevel: newHandInLevel,
          playersLeft: newPlayersLeft,
          isItm:       true,
          phase:       'itm',
        }
      }

      // Level up check
      if (newHandInLevel >= HANDS_PER_LEVEL) {
        const newLevelIndex = prev.levelIndex + 1
        if (newLevelIndex >= TOTAL_LEVELS) {
          return {
            ...prev,
            totalHands:  newTotalHands,
            handInLevel: 0,
            levelIndex:  newLevelIndex,
            playersLeft: newPlayersLeft,
            chipHistory: [...prev.chipHistory, heroStack],
            phase:       'win',
          }
        }
        const isDayBreak = getDay(newLevelIndex) !== getDay(prev.levelIndex)
        return {
          ...prev,
          totalHands:  newTotalHands,
          handInLevel: 0,
          levelIndex:  newLevelIndex,
          playersLeft: newPlayersLeft,
          chipHistory: [...prev.chipHistory, heroStack],
          phase:       isDayBreak ? 'day_break' : 'level_up',
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
        engine:          finalEngine,
        tableSeats:      updatedTableSeats,
        dealerButton:    btn,
        totalHands:      newTotalHands,
        handInLevel:     newHandInLevel,
        playersLeft:     newPlayersLeft,
        heroStack:       finalEngine.heroSeat.stack,
        heroStackBefore: stackBefore2,
        streetResults:   [],
        lastOption:      null,
        lastChipDelta:   0,
        guessOptions:    [],
        guessCorrect:    '',
        phase:           finalEngine.isOver ? 'recap' : 'playing',
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
        engine:          finalEngine,
        tableSeats:      updatedTableSeats,
        dealerButton:    btn,
        heroStack:       finalEngine.heroSeat.stack,
        heroStackBefore: stackBefore3,
        streetResults:   [],
        lastOption:      null,
        phase:           finalEngine.isOver ? 'recap' : 'playing',
      }
    })
  }, [])

  // ── Finalize tournament ───────────────────────────────────
  const finalizeTournament = useCallback(async (cashed: boolean) => {
    const s = stateRef.current
    if (!s.tournamentId) return
    await endTournament(
      s.tournamentId, s.heroStack, s.levelIndex,
      s.sessionScore, s.sessionMaxScore,
      s.sessionDecisions.length, cashed,
      getDay(s.levelIndex), s.levelIndex, s.playersLeft,
    )
  }, [])

  // ── localStorage save/resume ──────────────────────────────
  const hasSavedGame = useCallback((): boolean => {
    try {
      const raw = localStorage.getItem(SAVE_KEY)
      if (!raw) return false
      const data = JSON.parse(raw)
      if (Date.now() - data.savedAt >= 24 * 60 * 60 * 1000) return false
      if (data.deviceId && data.deviceId !== getOrCreateDeviceId()) return false
      return true
    } catch {
      return false
    }
  }, [])

  const clearSavedGame = useCallback(() => {
    localStorage.removeItem(SAVE_KEY)
  }, [])

  const saveTournament = useCallback(() => {
    try {
      const s = stateRef.current
      if (s.phase !== 'playing' && s.phase !== 'recap') return
      const saveData = {
        heroStack:       s.heroStack,
        levelIndex:      s.levelIndex,
        playersLeft:     s.playersLeft,
        totalHands:      s.totalHands,
        sessionScore:    s.sessionScore,
        sessionMaxScore: s.sessionMaxScore,
        dealerButton:    s.dealerButton,
        heroSeatIndex:   s.heroSeatIndex,
        tableSeats:      s.tableSeats.map(seat => ({
          seatIndex: seat.seatIndex,
          stack:     seat.stack,
          archetype: seat.archetype,
        })),
        deviceId: getOrCreateDeviceId(),
        savedAt:  Date.now(),
      }
      localStorage.setItem(SAVE_KEY, JSON.stringify(saveData))
    } catch {
      // Ignore storage errors
    }
  }, [])

  const getSavedGameInfo = useCallback((): {
    heroStack: number; levelIndex: number; totalHands: number;
    sessionScore: number; sessionMaxScore: number; savedAt: number
  } | null => {
    try {
      const raw = localStorage.getItem(SAVE_KEY)
      if (!raw) return null
      const data = JSON.parse(raw)
      if (Date.now() - data.savedAt >= 24 * 60 * 60 * 1000) return null
      if (data.deviceId && data.deviceId !== getOrCreateDeviceId()) return null
      return {
        heroStack:       data.heroStack,
        levelIndex:      data.levelIndex,
        totalHands:      data.totalHands,
        sessionScore:    data.sessionScore,
        sessionMaxScore: data.sessionMaxScore,
        savedAt:         data.savedAt,
      }
    } catch {
      return null
    }
  }, [])

  const resumeTournament = useCallback(() => {
    try {
      const raw = localStorage.getItem(SAVE_KEY)
      if (!raw) return
      const data = JSON.parse(raw)
      const heroSeatIndex = data.heroSeatIndex ?? 4
      const newDealerButton = getDealerButtonForHand(
        data.totalHands % HANDS_PER_LEVEL,
        heroSeatIndex
      )
      const rawSeats = createTable(data.heroStack)
      const positioned = assignPositions(rawSeats, newDealerButton)
      const seatsWithStacks = positioned.map((seat, i) => {
        if (i === heroSeatIndex) return { ...seat, stack: data.heroStack }
        const saved = data.tableSeats?.find((s: { seatIndex: number }) => s.seatIndex === i)
        return { ...seat, stack: saved?.stack ?? data.heroStack }
      })
      const engine = createHand(seatsWithStacks, heroSeatIndex, data.levelIndex, data.playersLeft)
      setState(prev => ({
        ...makeInitialState(prev.mode),
        engine,
        heroStack:       data.heroStack,
        levelIndex:      data.levelIndex,
        playersLeft:     data.playersLeft,
        totalHands:      data.totalHands,
        sessionScore:    data.sessionScore,
        sessionMaxScore: data.sessionMaxScore,
        dealerButton:    newDealerButton,
        heroSeatIndex,
        tableSeats:      seatsWithStacks,
        phase:           'playing',
      }))
      localStorage.removeItem(SAVE_KEY)
    } catch (e) {
      console.warn('Could not resume tournament', e)
      localStorage.removeItem(SAVE_KEY)
    }
  }, [])

  // Auto-save after each hand completes
  useEffect(() => {
    if (state.phase === 'recap' || state.phase === 'playing') {
      try {
        const saveData = {
          heroStack:       state.heroStack,
          levelIndex:      state.levelIndex,
          playersLeft:     state.playersLeft,
          totalHands:      state.totalHands,
          sessionScore:    state.sessionScore,
          sessionMaxScore: state.sessionMaxScore,
          dealerButton:    state.dealerButton,
          heroSeatIndex:   state.heroSeatIndex,
          tableSeats:      state.tableSeats.map(s => ({
            seatIndex: s.seatIndex,
            stack:     s.stack,
            archetype: s.archetype,
          })),
          deviceId: getOrCreateDeviceId(),
          savedAt:  Date.now(),
        }
        localStorage.setItem(SAVE_KEY, JSON.stringify(saveData))
      } catch {
        // Ignore storage errors
      }
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
    hasSavedGame,
    clearSavedGame,
    saveTournament,
    getSavedGameInfo,
    bb, sb, ante, bbDepth, day, nearBubble, scorePct,
  }
}
