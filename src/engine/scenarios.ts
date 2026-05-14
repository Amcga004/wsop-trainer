import type { Scenario } from '../types'
import {
  DEEP_RANGES,
  MID_RANGES,
  SHOVE_RANGES,
  BOARD_TEXTURE,
  getRanges,
  getShoveRanges,
  isInRFI,
  isInShoveRange,
  isCallableShove,
  BB_DEFENSE_FREQ,
  type Position,
  type ShoveTier,
} from './rangeData'
import {
  getBB,
  getSB,
  getAnte,
  getPreflopPotBase,
  getBBDepth,
  getOpenSize,
} from './tournamentStructure'

const RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2']
const SUITS = ['♠','♥','♦','♣']
const RED   = ['♥','♦']

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]
const isRed = (s: string) => RED.includes(s)

function toHandStr(c1: { r: string; s: string }, c2: { r: string; s: string }): string {
  if (c1.r === c2.r) return c1.r + c2.r
  const i1 = RANKS.indexOf(c1.r), i2 = RANKS.indexOf(c2.r)
  const [hi, lo] = i1 < i2 ? [c1, c2] : [c2, c1]
  return hi.r + lo.r + (c1.s === c2.s ? 's' : 'o')
}

function getStackTier(stackBB: number): 'deep' | 'mid' | 'shove' {
  if (stackBB >= 25) return 'deep'
  if (stackBB >= 20) return 'mid'
  return 'shove'
}

function getShoveTier(stackBB: number): ShoveTier {
  if (stackBB >= 15) return '15_19BB'
  if (stackBB >= 10) return '10_14BB'
  return 'under_10BB'
}

export function classifyBoard(board: { r: string; s: string }[]): keyof typeof BOARD_TEXTURE {
  if (!board || board.length < 3) return 'dry'
  const suits = board.map(c => c.s)
  const ranks = board.map(c => c.r)
  const RANK_VAL: Record<string, number> = {
    'A':14,'K':13,'Q':12,'J':11,'T':10,
    '9':9,'8':8,'7':7,'6':6,'5':5,'4':4,'3':3,'2':2,
  }
  const uniqueSuits = new Set(suits).size
  const rankVals = ranks.map(r => RANK_VAL[r]).sort((a, b) => b - a)
  const rankRange = rankVals[0] - rankVals[rankVals.length - 1]
  const uniqueRanks = new Set(ranks).size
  if (uniqueSuits === 1) return 'monotone'
  if (uniqueRanks < board.length) return 'paired'
  if (rankRange <= 4) return 'connected'
  if (uniqueSuits === 2 && rankRange <= 6) return 'wet'
  return 'dry'
}

function randBoard(count: number, texture: 'dry' | 'wet' | 'monotone' | 'paired' = 'dry') {
  const used = new Set<string>()
  const res: { r: string; s: string }[] = []
  const getRank = () => {
    let r: string
    do { r = pick(RANKS) } while (used.has(r) && texture !== 'paired')
    used.add(r)
    return r
  }
  if (texture === 'monotone') {
    const s = pick(SUITS)
    for (let i = 0; i < count; i++) res.push({ r: getRank(), s })
  } else if (texture === 'paired') {
    const r1 = pick(RANKS)
    const r3 = pick(RANKS.filter(r => r !== r1))
    res.push({ r: r1, s: pick(SUITS) }, { r: r1, s: pick(SUITS) })
    if (count >= 3) res.push({ r: r3, s: pick(SUITS) })
  } else if (texture === 'wet') {
    const s1 = pick(SUITS), s2 = pick(SUITS.filter(s => s !== s1))
    const suits = [s1, s1, s2, s1, s2]
    for (let i = 0; i < count; i++) res.push({ r: getRank(), s: suits[i] || pick(SUITS) })
  } else {
    const usedS: string[] = []
    for (let i = 0; i < count; i++) {
      const r = getRank()
      let s: string
      do { s = pick(SUITS) } while (usedS.includes(s) && usedS.length < 4)
      usedS.push(s)
      res.push({ r, s })
    }
  }
  return res.slice(0, count)
}

export function buildScenario(
  levelIndex: number,
  heroStack: number,
  seenIds: Set<string>
): Scenario {
  const bb    = getBB(levelIndex)
  const sb    = getSB(levelIndex)
  const ante  = getAnte(levelIndex)
  const depth = getBBDepth(heroStack, levelIndex)
  const base  = getPreflopPotBase(levelIndex)
  const open  = getOpenSize(levelIndex, heroStack, true)

  const tier    = getStackTier(depth)
  const isShove = tier === 'shove'
  const isMid   = tier === 'mid'
  const isDeep  = tier === 'deep'

  const pool: string[] = [
    ...Array(4).fill('pf_fold_trash'),
    ...Array(3).fill('pf_open'),
    ...Array(3).fill('pf_bb_defend'),
    ...(depth >= 20 ? Array(3).fill('pf_vs_3bet') : []),
    ...(isDeep || isMid ? Array(5).fill('fp_cbet_dry') : []),
    ...(isDeep || isMid ? Array(5).fill('fp_cbet_wet') : []),
    ...(isDeep || isMid ? Array(4).fill('fp_overpair_ace') : []),
    ...(isDeep || isMid ? Array(5).fill('fp_draw_hit') : []),
    ...(isDeep || isMid ? Array(5).fill('fp_draw_miss') : []),
    ...(isDeep || isMid ? Array(4).fill('fp_set') : []),
    ...(isDeep || isMid ? Array(3).fill('fp_multiway') : []),
    ...(isDeep || isMid ? Array(3).fill('fp_bb_defense') : []),
    ...(isShove ? Array(6).fill('ss_push_fold') :
      depth <= 25 ? Array(3).fill('ss_push_fold') : []),
  ]

  const type = pick(pool)

  function attempt(id: string, build: () => Scenario): Scenario {
    if (seenIds.has(id) && seenIds.size < pool.length) {
      return buildScenario(levelIndex, heroStack, seenIds)
    }
    seenIds.add(id)
    return build()
  }

  // ── PF FOLD TRASH ──────────────────────────────────────────
  if (type === 'pf_fold_trash') {
    const pos = pick(['UTG','HJ','CO','BTN','SB'])
    const trash = [
      [{ r:'9',s:'♣' }, { r:'2',s:'♦' }, '9♣2♦'],
      [{ r:'J',s:'♠' }, { r:'4',s:'♦' }, 'J♠4♦'],
      [{ r:'8',s:'♥' }, { r:'3',s:'♣' }, '8♥3♣'],
      [{ r:'7',s:'♦' }, { r:'2',s:'♠' }, '7♦2♠'],
      [{ r:'Q',s:'♦' }, { r:'5',s:'♥' }, 'Q♦5♥'],
    ] as const
    const [c1, c2, hName] = pick([...trash])
    const opener = pick(['UTG','UTG+1','LJ','HJ','CO'].filter(p => p !== pos))
    const id = `trash_${pos}_${hName}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'pf_fold_trash',
      heroPos: pos, heroCards: [c1, c2], handName: hName,
      preflopPot: base + open, activeSeats: [opener],
      villainHand: null, rangeKey: null, heroEquity: null,
      streets: [{
        street: 'Preflop', board: [], villainAction: 'open',
        desc: `${opener} opens to ${open.toLocaleString()}. Folds to you in ${pos} with ${hName}.`,
        actions: [
          { label: 'Shove all-in', cls: 'a-shove', quality: 'bad', chipCost: heroStack, ct: 'fold',
            coaching: `Never shove ${hName}. No equity, no reason to be in this pot.` },
          { label: `Raise to ${(open*2.5).toLocaleString()}`, cls: 'a-raise', quality: 'bad', chipCost: Math.round(open*2.5), ct: 'fold',
            coaching: `Bluffing with ${hName} burns chips with no equity when called.` },
          { label: `Call ${open.toLocaleString()}`, cls: 'a-call', quality: 'bad', chipCost: open, ct: 'fold',
            coaching: `Calling ${hName} leaks chips. You won't know where you stand postflop.` },
          { label: 'Fold', cls: 'a-fold', quality: 'best', chipCost: 0, ct: 'fold',
            coaching: `Correct. ${hName} folds always. Fast fold — protect your stack.` },
        ],
      }],
    }))
  }

  // ── PF OPEN ───────────────────────────────────────────────
  if (type === 'pf_open') {
    const pos = pick(['UTG','UTG1','LJ','HJ','CO','BTN','SB']) as Position
    const openCandidates: { r: string; s: string }[][] = [
      [{ r:'A',s:'♥' }, { r:'9',s:'♣' }],
      [{ r:'K',s:'♦' }, { r:'T',s:'♠' }],
      [{ r:'J',s:'♠' }, { r:'T',s:'♠' }],
      [{ r:'7',s:'♥' }, { r:'7',s:'♦' }],
      [{ r:'Q',s:'♣' }, { r:'9',s:'♣' }],
      [{ r:'6',s:'♦' }, { r:'5',s:'♦' }],
      [{ r:'A',s:'♣' }, { r:'6',s:'♣' }],
      [{ r:'K',s:'♥' }, { r:'J',s:'♦' }],
      [{ r:'T',s:'♠' }, { r:'9',s:'♠' }],
      [{ r:'8',s:'♥' }, { r:'8',s:'♣' }],
    ]
    const [c1, c2] = pick(openCandidates)
    const hStr  = toHandStr(c1, c2)
    const hName = `${c1.r}${c1.s}${c2.r}${c2.s}`
    const ranges = getRanges(pos, depth)
    const handInRange = ranges.rfi.includes(hStr)
    const id = `open_${pos}_${hStr}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'pf_open',
      heroPos: pos,
      heroCards: [c1, c2] as [{ r: string; s: string }, { r: string; s: string }],
      handName: hName,
      preflopPot: base, activeSeats: [],
      villainHand: null, rangeKey: null, heroEquity: null,
      streets: [{
        street: 'Preflop', board: [], villainAction: null,
        desc: `Folds to you in ${pos} with ${hName} (${hStr}). Stack: ${heroStack.toLocaleString()} (${depth}BB).`,
        actions: [
          {
            label: 'Fold',
            cls: 'a-fold',
            quality: handInRange ? 'bad' : 'best',
            chipCost: 0,
            ct: 'fold',
            coaching: handInRange
              ? `Folding ${hStr} from ${pos} is too tight. This hand is in your ${pos} opening range — raise and take initiative.`
              : `Correct. ${hStr} from ${pos} is outside your opening range at ${depth}BB. Patient folding is a tournament edge.`,
          },
          {
            label: 'Limp',
            cls: 'a-call',
            quality: 'bad',
            chipCost: bb,
            ct: 'fold',
            coaching: `Never limp in tournaments. Raise or fold — limping gives away positional initiative and builds a pot where you have no information.`,
          },
          {
            label: `Raise to ${open.toLocaleString()} — standard`,
            cls: 'a-raise',
            quality: handInRange ? 'best' : 'ok',
            chipCost: open,
            ct: 'fold',
            coaching: handInRange
              ? `Standard. ${hStr} from ${pos} at ${depth}BB — raise and apply pressure.`
              : `Marginal open. ${hStr} is borderline from ${pos}. Acceptable occasionally but fold is better without a specific read.`,
          },
          {
            label: `Raise larger`,
            cls: 'a-raise',
            quality: handInRange ? 'good' : 'ok',
            chipCost: Math.round(bb * 3),
            ct: 'fold',
            coaching: `Slightly larger than standard but fine. At ${depth}BB, ${open.toLocaleString()} is the preferred size.`,
          },
        ],
      }],
    }))
  }

  // ── PF BB DEFEND ──────────────────────────────────────────
  if (type === 'pf_bb_defend') {
    const openerPos = pick(['BTN','CO','HJ','LJ','SB']) as Position
    const defendCandidates: { r: string; s: string }[][] = [
      [{ r:'K',s:'♠' }, { r:'7',s:'♠' }],
      [{ r:'J',s:'♦' }, { r:'9',s:'♦' }],
      [{ r:'T',s:'♥' }, { r:'7',s:'♥' }],
      [{ r:'9',s:'♣' }, { r:'8',s:'♦' }],
      [{ r:'A',s:'♥' }, { r:'4',s:'♠' }],
      [{ r:'Q',s:'♦' }, { r:'7',s:'♦' }],
      [{ r:'6',s:'♣' }, { r:'4',s:'♣' }],
      [{ r:'3',s:'♥' }, { r:'3',s:'♦' }],
    ]
    const [c1, c2] = pick(defendCandidates)
    const hStr  = toHandStr(c1, c2)
    const hName = `${c1.r}${c1.s}${c2.r}${c2.s}`
    const bbRanges    = getRanges('BB', depth)
    const shouldDefend = bbRanges.vsRaiseCall.includes(hStr)
    const defFreq     = BB_DEFENSE_FREQ[openerPos as string] ?? 35
    const id = `bbdefend_${openerPos}_${hStr}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'pf_bb_defend',
      heroPos: 'BB',
      heroCards: [c1, c2] as [{ r: string; s: string }, { r: string; s: string }],
      handName: hName,
      preflopPot: base + open, activeSeats: [openerPos],
      villainHand: null, rangeKey: null, heroEquity: null,
      streets: [{
        street: 'Preflop', board: [], villainAction: 'open',
        desc: `${openerPos} opens to ${open.toLocaleString()}. SB folds. You're in BB with ${hName} (${hStr}). Pot: ${(base + open).toLocaleString()}.`,
        actions: [
          {
            label: 'Fold',
            cls: 'a-fold',
            quality: shouldDefend ? 'bad' : 'best',
            chipCost: 0,
            ct: 'fold',
            coaching: shouldDefend
              ? `Correct defense. BB defends ${defFreq}% vs ${openerPos} opens — ${hStr} qualifies. You're getting good pot odds and this hand has postflop playability.`
              : `Correct fold. ${hStr} is outside your BB defense range vs ${openerPos}. GTO defends ${defFreq}% here — this hand falls below that threshold.`,
          },
          {
            label: `Call ${(open - bb).toLocaleString()} — defend`,
            cls: 'a-call',
            quality: shouldDefend ? 'best' : 'bad',
            chipCost: open - bb,
            ct: shouldDefend ? 'next' : 'fold',
            coaching: shouldDefend
              ? `Correct defense. BB defends ${defFreq}% vs ${openerPos} opens — ${hStr} qualifies. You're getting good pot odds and this hand has postflop playability.`
              : `Calling ${hStr} vs ${openerPos} is too wide. GTO defends only ${defFreq}% — this hand falls outside that range.`,
          },
          {
            label: `3-bet to ${Math.round(open * 3).toLocaleString()}`,
            cls: 'a-3bet',
            quality: bbRanges.threebet.includes(hStr) ? 'best' : 'ok',
            chipCost: Math.round(open * 3),
            ct: 'fold',
            coaching: bbRanges.threebet.includes(hStr)
              ? `${hStr} is in BB's 3-bet range vs ${openerPos}. Take the initiative and build the pot.`
              : `3-betting ${hStr} is non-standard. Better to call and realize equity — or fold if out of range.`,
          },
          {
            label: 'Shove all-in',
            cls: 'a-shove',
            quality: 'bad',
            chipCost: heroStack,
            ct: 'fold',
            coaching: `Shoving with ${hStr} from BB vs an open is only correct at ≤20BB with a premium hand. At ${depth}BB, call or 3-bet instead.`,
          },
        ],
      }],
    }))
  }

  // ── PF VS 3-BET ──────────────────────────────────────────
  if (type === 'pf_vs_3bet') {
    const heroPos = pick(['CO','BTN','HJ','SB']) as Position
    const v3bCandidates: { r: string; s: string }[][] = [
      [{ r:'J',s:'♥' }, { r:'J',s:'♦' }],
      [{ r:'A',s:'♠' }, { r:'Q',s:'♦' }],
      [{ r:'K',s:'♣' }, { r:'Q',s:'♣' }],
      [{ r:'T',s:'♠' }, { r:'T',s:'♥' }],
      [{ r:'9',s:'♦' }, { r:'9',s:'♣' }],
      [{ r:'A',s:'♦' }, { r:'J',s:'♦' }],
      [{ r:'K',s:'♥' }, { r:'J',s:'♠' }],
    ]
    const [c1, c2] = pick(v3bCandidates)
    const hStr  = toHandStr(c1, c2)
    const hName = `${c1.r}${c1.s}${c2.r}${c2.s}`
    const heroRanges = getRanges(heroPos, depth)
    const shouldCall = heroRanges.vs3betCall.includes(hStr)
    const should4bet = heroRanges.fourbet.includes(hStr)
    const threeBetAmt = Math.round(open * 3)
    const fourBetAmt  = Math.round(bb * 22)
    const id = `vs3bet_${heroPos}_${hStr}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'pf_vs_3bet',
      heroPos,
      heroCards: [c1, c2] as [{ r: string; s: string }, { r: string; s: string }],
      handName: hName,
      preflopPot: base + open + threeBetAmt, activeSeats: ['BB'],
      villainHand: null, rangeKey: null, heroEquity: null,
      streets: [{
        street: 'Preflop', board: [], villainAction: '3bet',
        desc: `You open to ${open.toLocaleString()} from ${heroPos} with ${hName} (${hStr}). BB 3-bets to ${threeBetAmt.toLocaleString()}. Pot: ${(base + open + threeBetAmt).toLocaleString()}.`,
        actions: [
          {
            label: 'Fold',
            cls: 'a-fold',
            quality: (!shouldCall && !should4bet) ? 'best' : 'bad',
            chipCost: 0,
            ct: 'fold',
            coaching: (!shouldCall && !should4bet)
              ? `Correct. ${hStr} from ${heroPos} is outside your vs-3bet range at ${depth}BB. Folding preserves your stack.`
              : `Folding ${hStr} is too tight. This hand continues vs a 3-bet — ${should4bet ? '4-bet or call' : 'call'}.`,
          },
          {
            label: `Call ${(threeBetAmt - open).toLocaleString()} — see flop`,
            cls: 'a-call',
            quality: shouldCall ? 'best' : (should4bet ? 'ok' : 'bad'),
            chipCost: threeBetAmt - open,
            ct: shouldCall ? 'next' : 'fold',
            coaching: shouldCall
              ? `Correct. ${hStr} is in your vs-3bet call range from ${heroPos}. Realize equity in position.`
              : should4bet
              ? `Calling ${hStr} is a slow play — 4-betting is more aggressive and appropriate at this depth.`
              : `Calling ${hStr} vs a 3-bet is too loose at ${depth}BB from ${heroPos}. Fold and pick a better spot.`,
          },
          {
            label: `4-bet to ${fourBetAmt.toLocaleString()}`,
            cls: 'a-3bet',
            quality: should4bet ? 'best' : 'bad',
            chipCost: fourBetAmt,
            ct: 'fold',
            coaching: should4bet
              ? `Correct. ${hStr} from ${heroPos} is a 4-bet hand — apply maximum pressure.`
              : `4-betting ${hStr} vs a 3-bet commits too many chips without the hand strength to justify it at ${depth}BB.`,
          },
          {
            label: 'Shove all-in',
            cls: 'a-shove',
            quality: (should4bet && depth <= 25) ? 'best' : 'bad',
            chipCost: heroStack,
            ct: 'fold',
            coaching: (should4bet && depth <= 25)
              ? `At ${depth}BB, shoving and 4-betting merge — this is correct with ${hStr}.`
              : `Shoving here is too aggressive without a premium hand or a short-stack situation.`,
          },
        ],
      }],
    }))
  }

  // ── OVERPAIR VS ACE ────────────────────────────────────────
  if (type === 'fp_overpair_ace') {
    const heroPos = pick(['BTN','CO'])
    const pairs = [
      [{ r:'Q',s:'♥' }, { r:'Q',s:'♦' }, 'Q♥Q♦'],
      [{ r:'J',s:'♠' }, { r:'J',s:'♣' }, 'J♠J♣'],
      [{ r:'K',s:'♠' }, { r:'K',s:'♥' }, 'K♠K♥'],
    ] as const
    const [c1, c2, hName] = pick([...pairs])
    const threeAmt = Math.round(bb * 8)
    const pfPot   = base + threeAmt
    const cbetAmt = Math.round(pfPot * 0.65)
    const aceFlop = randBoard(3, 'dry')
    aceFlop[0]    = { r: 'A', s: pick(SUITS) }
    const id = `overpair_${c1.r}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'fp_overpair_ace',
      heroPos, heroCards: [c1, c2], handName: hName,
      preflopPot: pfPot, activeSeats: ['BB'],
      villainHand: { r1:'A', s1:'♣', r2:'J', s2:'♥', name:'A♣J♥ — top pair', pos:'BB', archetype:'TA' },
      rangeKey: 'bb3betBTN', heroEquity: 22,
      streets: [
        {
          street: 'Preflop', board: [], villainAction: 'call',
          desc: `You 3-bet ${hName} to ${threeAmt.toLocaleString()} from ${heroPos}. BB calls. Pot: ${pfPot.toLocaleString()}.`,
          actions: [
            { label: 'Fold — wait for better', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold',
              coaching: `${hName} never folds preflop. Premium hand — 3-bet always.` },
            { label: `Call ${open.toLocaleString()} — passive`, cls: 'a-call', quality: 'ok', chipCost: open, ct: 'next',
              coaching: `Passive with ${hName}. 3-bet to build the pot and take initiative.` },
            { label: `3-bet to ${threeAmt.toLocaleString()} — standard`, cls: 'a-3bet', quality: 'best', chipCost: threeAmt, ct: 'next',
              coaching: `Standard. ${hName} from ${heroPos} — take initiative and build the pot.` },
            { label: `3-bet large — ${(threeAmt*1.5).toLocaleString()}`, cls: 'a-3bet', quality: 'best', chipCost: Math.round(threeAmt*1.5), ct: 'next',
              coaching: `Larger 3-bet also fine — cuts implied odds and extracts more preflop.` },
          ],
        },
        {
          street: 'Flop', board: aceFlop, villainAction: 'bet',
          desc: `Flop ${aceFlop.map(c => c.r+c.s).join(' ')} — the dreaded ace. BB bets ${cbetAmt.toLocaleString()} (~65% pot).`,
          actions: [
            { label: 'Fold — ace kills overpair', cls: 'a-fold', quality: 'best', chipCost: 0, ct: 'fold',
              coaching: `Correct tournament adjustment. BB called your 3-bet then c-bet 65% on ace-high. Their range is packed with Ax. ${hName} is now a bluff-catcher at best. Jonathan Little: do not pay off crushed holdings. Fold and preserve your tournament life.` },
            { label: `Call ${cbetAmt.toLocaleString()} — overpair is strong`, cls: 'a-call', quality: 'bad', chipCost: cbetAmt, ct: 'fold',
              coaching: `Cash game instinct. In tournaments, calling overpairs down on ace-high vs a 3-bet caller who c-bet 65% bleeds chips. They almost always have an ace.` },
            { label: `Raise to ${Math.round(cbetAmt*2.5).toLocaleString()}`, cls: 'a-raise', quality: 'bad', chipCost: Math.round(cbetAmt*2.5), ct: 'fold',
              coaching: `Raising ${hName} on ace-high vs a 3-bet caller who fired 65% pot turns your hand into a bluff against a range full of aces.` },
            { label: 'Shove all-in', cls: 'a-shove', quality: 'bad', chipCost: heroStack, ct: 'fold',
              coaching: `Major chip dump. They have the ace. Fold is the only correct action.` },
          ],
        },
      ],
    }))
  }

  // ── DRAW MISSES ────────────────────────────────────────────
  if (type === 'fp_draw_miss') {
    const pfPot   = base + open
    const flopBet = Math.round(pfPot * 0.5)
    const turnPot = pfPot + flopBet * 2
    const turnBet = Math.round(turnPot * 0.5)
    const rivPot  = turnPot + turnBet * 2
    const flop    = [{ r:'6',s:'♠' }, { r:'7',s:'♠' }, { r:'K',s:'♦' }]
    const turn    = [...flop, { r:'T',s:'♥' }]
    const river   = [...turn, { r:'J',s:'♣' }]
    const id      = `drawmiss_A5s_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'fp_draw_miss',
      heroPos: 'BTN', heroCards: [{ r:'A',s:'♠' }, { r:'5',s:'♠' }], handName: 'A♠5♠',
      preflopPot: pfPot, activeSeats: ['CO'],
      villainHand: { r1:'K', s1:'♥', r2:'K', s2:'♦', name:'K♥K♦ — called two streets with overpair', pos:'CO', archetype:'LP' },
      rangeKey: 'coopen', heroEquity: 48,
      streets: [
        {
          street: 'Preflop', board: [], villainAction: 'open',
          desc: `CO opens ${open.toLocaleString()}. You're on BTN with A♠5♠ — nut flush draw potential.`,
          actions: [
            { label: 'Fold', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold',
              coaching: `A5s has nut flush draw potential. Slightly too tight here.` },
            { label: `Call ${open.toLocaleString()} — IP`, cls: 'a-call', quality: 'best', chipCost: open, ct: 'next',
              coaching: `Good. A5s in position — nut flush draw with implied odds. Standard call.` },
            { label: `3-bet to ${Math.round(bb*8).toLocaleString()} — blocker`, cls: 'a-3bet', quality: 'good', chipCost: Math.round(bb*8), ct: 'next',
              coaching: `Also valid. Ace blocks AA/AK in their 4-bet range. Semi-bluff 3-bet.` },
            { label: `3-bet large`, cls: 'a-3bet', quality: 'ok', chipCost: Math.round(bb*12), ct: 'next',
              coaching: `Slightly large. Standard 3-bet is 2.5–3x the open.` },
          ],
        },
        {
          street: 'Flop', board: flop, villainAction: 'bet',
          desc: `Flop 6♠7♠K♦ — NUT FLUSH DRAW + gutshot to wheel. CO bets ${flopBet.toLocaleString()}.`,
          actions: [
            { label: 'Fold — just a draw', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold',
              coaching: `Never fold a combo draw. ~47% equity here — you're nearly a coin flip.` },
            { label: `Call ${flopBet.toLocaleString()} — see turn`, cls: 'a-call', quality: 'good', chipCost: flopBet, ct: 'next',
              coaching: `Fine. Massive equity — calling is the safe line.` },
            { label: `Raise — semi-bluff`, cls: 'a-raise', quality: 'best', chipCost: Math.round(flopBet*2.5), ct: 'next',
              coaching: `Strong. 13 outs — raise to build a pot you can win two ways: fold equity now or hitting the draw.` },
            { label: 'Shove all-in', cls: 'a-shove', quality: depth < 40 ? 'good' : 'ok', chipCost: heroStack, ct: 'next',
              coaching: depth < 40 ? `Valid at this depth — combo draw has significant equity.` : `Deep — give up too much fold equity. Raise or call instead.` },
          ],
        },
        {
          street: 'Turn', board: turn, villainAction: 'bet',
          desc: `Turn T♥ — draws still live. CO bets ${turnBet.toLocaleString()}.`,
          actions: [
            { label: 'Fold — still drawing', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold',
              coaching: `Don't fold a 13-out draw on the turn. ~30% equity remaining — you have odds.` },
            { label: `Call ${turnBet.toLocaleString()} — see river`, cls: 'a-call', quality: 'good', chipCost: turnBet, ct: 'next',
              coaching: `Standard. You have odds to call with 13 outs (~30% equity vs ~25% needed).` },
            { label: `Raise — maximum pressure`, cls: 'a-raise', quality: 'best', chipCost: Math.round(turnBet*2.5), ct: 'next',
              coaching: `Best. Two ways to win — fold equity now, plus hitting the draw. Apply maximum pressure.` },
            { label: 'Shove all-in', cls: 'a-shove', quality: 'good', chipCost: heroStack, ct: 'next',
              coaching: `Also valid. Shoving denies villain's equity and puts maximum pressure.` },
          ],
        },
        {
          street: 'River', board: river, villainAction: 'check',
          desc: `River J♣ — BOTH DRAWS MISSED. Ace-high only. CO checks. Pot: ${rivPot.toLocaleString()}.`,
          actions: [
            { label: 'Check — give up', cls: 'a-check', quality: 'best', chipCost: 0, ct: 'showdown',
              coaching: `CORRECT. Both draws missed. They called TWO streets with KK — a calling station is not folding to a river bluff. Jonathan Little: this is the exact leak to eliminate. Check back. Discipline here saves thousands of chips per tournament.` },
            { label: `Bet small — probe`, cls: 'a-raise', quality: 'bad', chipCost: Math.round(rivPot*0.3), ct: 'fold',
              coaching: `They called two streets with an overpair. A small bet gets called or check-raised. You have no equity — don't add chips to a losing hand.` },
            { label: `Bet large — bluff`, cls: 'a-raise', quality: 'bad', chipCost: Math.round(rivPot*0.7), ct: 'fold',
              coaching: `The exact leak to break. They called flop AND turn. They are not folding now. Check and move on.` },
            { label: 'Shove all-in', cls: 'a-shove', quality: 'bad', chipCost: heroStack, ct: 'fold',
              coaching: `Most expensive version of this leak. Draw missed + calling station with overpair = always check. Period.` },
          ],
        },
      ],
    }))
  }

  // ── C-BET DRY ─────────────────────────────────────────────
  if (type === 'fp_cbet_dry') {
    const pfPot   = base + open
    const board   = randBoard(3, 'dry')
    const texture = classifyBoard(board)
    const texStrat = BOARD_TEXTURE[texture]
    const sm  = Math.round(pfPot * 0.33)
    const med = Math.round(pfPot * 0.5)
    const lg  = Math.round(pfPot * 0.75)
    const id  = `cbetdry_${board.map(c=>c.r).join('')}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'fp_cbet_dry',
      heroPos: 'BTN', heroCards: [{ r:'A',s:'♠' }, { r:'K',s:'♦' }], handName: 'A♠K♦',
      preflopPot: pfPot, activeSeats: ['BB'],
      villainHand: { r1:'J', s1:'♥', r2:'9', s2:'♦', name:'J♥9♦ — missed', pos:'BB', archetype:'LP' },
      rangeKey: 'bb3betBTN', heroEquity: 58,
      streets: [
        {
          street: 'Preflop', board: [], villainAction: 'call',
          desc: `You open AK to ${open.toLocaleString()} from BTN. BB calls. Pot: ${pfPot.toLocaleString()}.`,
          actions: [
            { label: 'Fold', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold', coaching: `Never fold AK preflop.` },
            { label: `Limp ${bb.toLocaleString()}`, cls: 'a-call', quality: 'bad', chipCost: bb, ct: 'fold', coaching: `Limping AK gives away initiative. Always raise.` },
            { label: `Raise to ${open.toLocaleString()} — standard`, cls: 'a-raise', quality: 'best', chipCost: open, ct: 'next', coaching: `Standard BTN open.` },
            { label: `Raise to ${Math.round(bb*4).toLocaleString()} — larger`, cls: 'a-raise', quality: 'good', chipCost: Math.round(bb*4), ct: 'next', coaching: `Slightly larger than standard but fine.` },
          ],
        },
        {
          street: 'Flop', board, villainAction: 'check',
          desc: `Flop ${board.map(c=>c.r+c.s).join(' ')} — ${texStrat.label}. BB checks. Pot: ${pfPot.toLocaleString()}.`,
          actions: [
            { label: 'Check back', cls: 'a-check', quality: 'ok', chipCost: 0, ct: 'next',
              coaching: `${texStrat.note} Checking AK back occasionally is fine for balance, but you lose value on a board where BB checks.` },
            { label: `Bet ${sm.toLocaleString()} — 33% pot`, cls: 'a-raise', quality: 'best', chipCost: sm, ct: 'next',
              coaching: `Perfect sizing. ${texStrat.note} C-bet frequency here is ~${Math.round(texStrat.cBetFreq*100)}% — small sizing maximizes folds and value.` },
            { label: `Bet ${med.toLocaleString()} — 50% pot`, cls: 'a-raise', quality: 'good', chipCost: med, ct: 'next',
              coaching: `Good standard sizing. Slightly more than needed on a ${texStrat.label.toLowerCase()} board.` },
            { label: `Bet ${lg.toLocaleString()} — 75% pot`, cls: 'a-raise', quality: 'bad', chipCost: lg, ct: 'next',
              coaching: `Too large. Jonathan Little: oversizing on a ${texStrat.label.toLowerCase()} board folds out hands that would call a smaller bet. Small bet accomplishes the same folds with less risk.` },
          ],
        },
      ],
    }))
  }

  // ── C-BET WET ─────────────────────────────────────────────
  if (type === 'fp_cbet_wet') {
    const pfPot    = base + open
    const board    = randBoard(3, 'wet')
    const texture  = classifyBoard(board)
    const texStrat = BOARD_TEXTURE[texture]
    const sm  = Math.round(pfPot * 0.40)
    const med = Math.round(pfPot * 0.65)
    const lg  = Math.round(pfPot * 0.80)
    const id  = `cbetwet_${board.map(c=>c.r).join('')}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'fp_cbet_wet',
      heroPos: 'BTN', heroCards: [{ r:'A',s:'♠' }, { r:'K',s:'♦' }], handName: 'A♠K♦',
      preflopPot: pfPot, activeSeats: ['BB'],
      villainHand: { r1:'9', s1:'♥', r2:'8', s2:'♥', name:'9♥8♥ — flush draw', pos:'BB', archetype:'LA' },
      rangeKey: 'bb3betBTN', heroEquity: 52,
      streets: [
        {
          street: 'Preflop', board: [], villainAction: 'call',
          desc: `You open AK to ${open.toLocaleString()} from BTN. BB calls. Pot: ${pfPot.toLocaleString()}.`,
          actions: [
            { label: 'Fold', cls: 'a-fold', quality: 'bad', chipCost: 0, ct: 'fold', coaching: `Never fold AK preflop.` },
            { label: `Limp ${bb.toLocaleString()}`, cls: 'a-call', quality: 'bad', chipCost: bb, ct: 'fold', coaching: `Limping AK gives away initiative. Always raise.` },
            { label: `Raise to ${open.toLocaleString()} — standard`, cls: 'a-raise', quality: 'best', chipCost: open, ct: 'next', coaching: `Standard BTN open with AK.` },
            { label: `Raise to ${Math.round(bb*4).toLocaleString()} — larger`, cls: 'a-raise', quality: 'good', chipCost: Math.round(bb*4), ct: 'next', coaching: `Slightly larger than standard but fine.` },
          ],
        },
        {
          street: 'Flop', board, villainAction: 'check',
          desc: `Flop ${board.map(c=>c.r+c.s).join(' ')} — ${texStrat.label}. BB checks. Pot: ${pfPot.toLocaleString()}.`,
          actions: [
            { label: 'Check back', cls: 'a-check', quality: 'best', chipCost: 0, ct: 'next',
              coaching: `${texStrat.note} C-bet frequency here is only ~${Math.round(texStrat.cBetFreq*100)}%. Checking AK protects your range and lets villain bluff the turn.` },
            { label: `Bet ${sm.toLocaleString()} — small`, cls: 'a-raise', quality: 'bad', chipCost: sm, ct: 'next',
              coaching: `Undersized on a ${texStrat.label.toLowerCase()} board. Jonathan Little: small bets charge draws nothing. Bet large or check.` },
            { label: `Bet ${med.toLocaleString()} — 65% pot`, cls: 'a-raise', quality: 'good', chipCost: med, ct: 'next',
              coaching: `${texStrat.note} When you bet on a ${texStrat.label.toLowerCase()} board, use this sizing — charges draws and builds the pot with your strong hands.` },
            { label: `Bet ${lg.toLocaleString()} — 80% pot`, cls: 'a-raise', quality: 'good', chipCost: lg, ct: 'next',
              coaching: `Large sizing is correct on ${texStrat.label.toLowerCase()} boards. ${med.toLocaleString()} (65%) is preferred but 80% is also fine.` },
          ],
        },
      ],
    }))
  }

  // ── SS PUSH FOLD ───────────────────────────────────────────
  if (type === 'ss_push_fold') {
    const heroPos = pick(['CO','BTN','HJ','SB']) as Position
    const pushCandidates: { r: string; s: string }[][] = [
      [{ r:'A',s:'♥' }, { r:'7',s:'♦' }],
      [{ r:'K',s:'♠' }, { r:'Q',s:'♥' }],
      [{ r:'8',s:'♥' }, { r:'8',s:'♣' }],
      [{ r:'T',s:'♦' }, { r:'9',s:'♣' }],
      [{ r:'A',s:'♣' }, { r:'3',s:'♣' }],
      [{ r:'J',s:'♠' }, { r:'6',s:'♠' }],
      [{ r:'7',s:'♦' }, { r:'7',s:'♣' }],
      [{ r:'K',s:'♥' }, { r:'5',s:'♥' }],
    ]
    const [c1, c2] = pick(pushCandidates)
    const hStr  = toHandStr(c1, c2)
    const hName = `${c1.r}${c1.s}${c2.r}${c2.s}`
    const shoveRanges = getShoveRanges(heroPos, depth)
    const shouldShove = shoveRanges.shove.includes(hStr)
    const id = `push_${heroPos}_${hStr}_${depth}`
    return attempt(id, () => ({
      id, scenarioType: 'ss_push_fold',
      heroPos,
      heroCards: [c1, c2] as [{ r: string; s: string }, { r: string; s: string }],
      handName: hName,
      preflopPot: base, activeSeats: [],
      villainHand: null, rangeKey: null, heroEquity: null,
      streets: [{
        street: 'Preflop', board: [], villainAction: null,
        desc: `Stack: ${heroStack.toLocaleString()} (${depth}BB). Orbit costs ${(sb+bb+ante).toLocaleString()}. Folds to you in ${heroPos} with ${hStr}. Jonathan Little: any bet committing >35% of your stack must be a shove.`,
        actions: [
          {
            label: 'Fold — wait for better',
            cls: 'a-fold',
            quality: shouldShove ? 'bad' : 'ok',
            chipCost: 0,
            ct: 'fold',
            coaching: shouldShove
              ? `Too tight. ${hStr} in ${heroPos} at ${depth}BB is a standard shove. Orbit costs ${(sb+bb+ante).toLocaleString()} — you can't afford to wait.`
              : `Folding ${hStr} at ${depth}BB from ${heroPos} is acceptable. This hand falls outside your shove range — be selective.`,
          },
          {
            label: `Open to ${(bb*2).toLocaleString()} — raise-fold`,
            cls: 'a-raise',
            quality: 'bad',
            chipCost: bb*2,
            ct: 'fold',
            coaching: `Jonathan Little: "Either shove or fold — no middle ground at this depth." Any bet over 35% of stack must be all-in.`,
          },
          {
            label: 'Shove all-in',
            cls: 'a-shove',
            quality: shouldShove ? 'best' : 'ok',
            chipCost: heroStack,
            ct: 'fold',
            coaching: shouldShove
              ? `Correct. ${hStr} at ${depth}BB from ${heroPos} is in your shove range — fold equity plus hand equity make this profitable.`
              : `Shoving ${hStr} is marginally aggressive at ${depth}BB from ${heroPos}. Acceptable but fold is slightly preferred.`,
          },
          {
            label: `Min-raise to trap`,
            cls: 'a-raise',
            quality: 'ok',
            chipCost: bb*2,
            ct: 'fold',
            coaching: `With your very best hands, a min-raise to induce a shove is fine. With everything else at this depth, go all-in directly.`,
          },
        ],
      }],
    }))
  }

  // Fallback — recurse if type not yet implemented (fp_draw_hit, fp_set, etc.)
  return buildScenario(levelIndex, heroStack, seenIds)
}
