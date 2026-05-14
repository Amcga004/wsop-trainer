// src/engine/rangeData.ts
// ─────────────────────────────────────────────────────────────
// WSOP Tournament Trainer — Complete Preflop Range Matrix
// 9-handed, BB ante format
//
// Sources:
//   - PokerCoaching GTO MTT charts
//   - Jonathan Little tournament strategy
//   - Custom coaching document (Sections 2, 5)
//   - GTO frequency ≥ 50% → train as always do it
//
// Design principles:
//   - Loose where GTO supports it (calls extended to 50% threshold)
//   - 3-bet bluffs = blocker hands only (suited aces A3s-A5s)
//   - Suited connectors always CALL, never 3-bet bluff
//   - Offsuit hands held to stricter standard (lose equity OOP/multiway)
//   - Deep stack = 40BB+ (single tier, same ranges)
//   - Mid stack  = 25-35BB
//   - Shove/fold = <20BB (subdivided by depth)
//   - Short      = 20-24BB (open-raise still legal but very tight)
// ─────────────────────────────────────────────────────────────

export type Position = 'UTG' | 'UTG1' | 'UTG2' | 'LJ' | 'HJ' | 'CO' | 'BTN' | 'SB' | 'BB'
export type StackTier = 'deep' | 'mid' | 'short' | 'shove'
export type ShoveTier = '15_19BB' | '10_14BB' | 'under_10BB'

export interface RangeSet {
  rfi:        string[]   // Raise first in (open raise)
  vsRaiseCall: string[]  // Call facing an open raise
  threebet:   string[]   // 3-bet range vs open raise
  vs3betCall: string[]   // Call facing a 3-bet after you opened
  fourbet:    string[]   // 4-bet range vs a 3-bet
}

export interface PushFoldRange {
  shove:     string[]   // Shove first in
  callShove: string[]   // Call an all-in shove
}

// ─────────────────────────────────────────────────────────────
// BOARD TEXTURE STRATEGY
// Used by scenarios.ts to gate c-bet frequency and sizing
// Source: coaching document Section 3 + GTO Wizard MTT data
// ─────────────────────────────────────────────────────────────
export const BOARD_TEXTURE = {
  dry: {
    // e.g. 2d 7s Qh — rainbow, no straight draws, no flush draws
    cBetFreq:   0.65,   // 60-70%
    cBetSizing: 0.40,   // 30-50% pot — small, charges nothing, folds weak hands
    label: 'Dry rainbow',
    note: 'C-bet high frequency with small sizing. Dry boards favor the preflop raiser — opponent range missed this board more often than yours.',
  },
  wet: {
    // e.g. 8h 9h Td — two-tone or connected, draws everywhere
    cBetFreq:   0.30,   // 25-35%
    cBetSizing: 0.65,   // 60-75% pot — large when you do bet, charges draws
    label: 'Wet / coordinated',
    note: 'C-bet low frequency with large sizing. Wet boards connect with the caller\'s range. When you bet, size up to charge draws. Check your weak hands.',
  },
  paired: {
    // e.g. 3h 3s 8d — board pair reduces opponent combos
    cBetFreq:   0.60,   // 55-65%
    cBetSizing: 0.40,   // 30-50% pot — small, board pair helps raiser
    label: 'Paired board',
    note: 'C-bet frequently with small sizing. Paired boards favor the preflop raiser — opponent has fewer trips combos. Extract value from overpairs and top pairs.',
  },
  monotone: {
    // e.g. Ah Kh Qh — all one suit
    cBetFreq:   0.25,   // 20-30%
    cBetSizing: 0.65,   // 60-75% pot — large when you bet
    label: 'Monotone',
    note: 'C-bet low frequency. Monotone boards are dangerous — caller\'s range has many flush draws. Bet large when you have the flush or strong equity. Check everything else.',
  },
  connected: {
    // e.g. 7c 8d 9h — straight draws in play
    cBetFreq:   0.35,   // 30-40%
    cBetSizing: 0.60,   // 55-70% pot
    label: 'Connected / straight draw heavy',
    note: 'C-bet selectively with medium-large sizing. Connected boards hit the caller\'s range hard. Only bet with strong hands, strong draws, or clear range advantage.',
  },
}

// ─────────────────────────────────────────────────────────────
// RANGE DATA — for the 13×13 range grid display
// ─────────────────────────────────────────────────────────────
export interface RangeData {
  label:    string
  value:    string[]   // Value hands (green in grid)
  bluff:    string[]   // Bluff/draw hands (yellow in grid)
  note:     string
  narrowed?: boolean
}

export const RANGE_DATA: Record<string, RangeData> = {
  utgopen:   { label: 'UTG opening range (12%)',  value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AQs','AJs','ATs','A9s','KQs','KJs','QJs','JTs','T9s','AKo','AQo','AJo','KQo','QJo'], bluff: [], note: 'Tight UTG range — 44+, strong suited, QJo+ offsuit.' },
  utg1open:  { label: 'UTG+1 opening range (14%)', value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AQs','AJs','ATs','A9s','A8s','KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s','AKo','AQo','AJo','KQo','QJo'], bluff: [], note: 'Slightly wider than UTG — adds A8s, KTs, QTs, 98s.' },
  utg2open:  { label: 'UTG+2 opening range (15%)', value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AQs','AJs','ATs','A9s','A8s','A7s','KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s','87s','AKo','AQo','AJo','KQo','QJo'], bluff: [], note: 'Adds A7s, 87s.' },
  ljopen:    { label: 'LJ opening range (18%)',   value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','KQs','KJs','KTs','K9s','QJs','QTs','JTs','T9s','98s','87s','76s','AKo','AQo','AJo','ATo','KQo','KJo','QJo'], bluff: [], note: 'LJ opens ~18% — adds suited kings, Q9s, 76s, ATo.' },
  hjopen:    { label: 'HJ opening range (22%)',   value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','KQs','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','Q8s','JTs','J9s','T9s','98s','87s','76s','65s','AKo','AQo','AJo','ATo','KQo','KJo','QJo'], bluff: [], note: 'HJ opens ~22% — adds A4s-A5s, K8s, Q8s-Q9s, J9s, 65s.' },
  coopen:    { label: 'CO opening range (30%)',   value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','86s','76s','65s','54s','AKo','AQo','AJo','ATo','A9o','KQo','KJo','KTo','QJo','QTo','JTo'], bluff: [], note: 'CO opens ~30% — all suited aces, most suited kings, wide suited connectors, QTo+.' },
  btnopen:   { label: 'BTN opening range (45%)',  value: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','Q7s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','86s','76s','75s','65s','64s','54s','AKo','AQo','AJo','ATo','A9o','A8o','KQo','KJo','KTo','K9o','QJo','QTo','JTo','T9o'], bluff: [], note: 'BTN opens ~45% — position is the asset. Nearly all suited hands, wide offsuit broadways.' },
  sbopen:    { label: 'SB opening range (38%)',   value: ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KJs','KTs','K9s','K8s','K7s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','87s','76s','65s','54s','AKo','AQo','AJo','ATo','A9o','A8o','KQo'], bluff: [], note: 'SB vs BB only — wide suited range but tight offsuit. OOP postflop limits offsuit playability.' },
  btn3bet:   { label: 'BTN 3-bet range vs CO',   value: ['AA','KK','QQ','JJ','TT','99','AKs','AQs','AJs','A5s','A4s','KQs','QJs','JTs','T9s','AKo','AQo','AJo','KQo'], bluff: ['A5s','A4s','QJs','JTs','T9s'], note: '3-bet value (TT+, AK-AQs) + blocker bluffs (suited aces). Suited connectors CALL, not 3-bet.' },
  bb3betBTN: { label: 'BB 3-bet range vs BTN',   value: ['AA','KK','QQ','JJ','AKs','AQs','A5s','A4s','A3s','KQs','AKo','AQo'], bluff: ['A5s','A4s','A3s'], note: 'BB 3-bets for value (JJ+, AK-AQs) and blocks with suited aces. Suited connectors go in the call range — realize equity, don\'t blow them up as bluffs.' },
}

// Narrow range based on street action (for range grid display)
export function narrowRange(
  key: string,
  street: string,
  villainAction: string | null,
  board: { r: string; s: string }[]
): (RangeData & { narrowed: boolean }) | null {
  const base = RANGE_DATA[key]
  if (!base) return null

  let value = [...base.value]
  let bluff = [...base.bluff]
  let note  = base.note

  const hasA = board.some(c => c.r === 'A')
  const hasK = board.some(c => c.r === 'K')

  if (street === 'Flop' && villainAction) {
    if (villainAction === 'bet') {
      if (hasA) {
        value = value.filter(h => !['KK','QQ','JJ','TT'].includes(h))
        note = 'Betting ace-high: range weighted toward Ax and draws. KK/QQ/JJ usually check back.'
      } else if (hasK) {
        value = value.filter(h => !['QQ','JJ','TT'].includes(h))
        note = 'Betting king-high: strong Kx bets, medium pairs check more often.'
      } else {
        note = 'Betting: strong made hands and semi-bluffs. Medium hands check.'
      }
    } else if (villainAction === 'check') {
      if (hasA) {
        value = value.filter(h => !['AA','AKs','AKo','AQs','AQo','AJs'].includes(h))
        note = 'Checking: medium hands, missed broadways. Strong Ax always c-bets ace-high boards.'
      } else {
        value = value.filter(h => !['AA','KK'].includes(h))
        bluff = []
        note = 'Checking: medium-strength, showdown-value hands. Nutted hands barrel.'
      }
    }
  }

  if (street === 'Turn' && villainAction) {
    if (villainAction === 'bet') {
      value = value.filter(h =>
        ['AA','KK','QQ','JJ','AKs','AKo','AQs','AQo','AJs'].includes(h) ||
        bluff.includes(h)
      )
      note = 'Double barrel: polarized — strong value or committed draws. Medium hands check turn.'
    } else if (villainAction === 'check') {
      value = value.filter(h => !['AA','KK','AKs','AKo','AQs'].includes(h))
      bluff = []
      note = 'Checked turn: showdown-value hands. Strong hands always barrel twice.'
    }
  }

  return { ...base, value, bluff, note, narrowed: street !== 'Preflop' }
}

// Build 13×13 range grid HTML
export function buildRangeGrid(
  rd: RangeData & { narrowed?: boolean },
  heroCards?: { r: string; s: string }[]
): string {
  const RANKS = ['A','K','Q','J','T','9','8','7','6','5','4','3','2']
  const VS = new Set(rd.value)
  const BS = new Set(rd.bluff)

  let heroCell: string | null = null
  if (heroCards && heroCards.length >= 2) {
    const r1 = heroCards[0].r, r2 = heroCards[1].r
    const s1 = heroCards[0].s, s2 = heroCards[1].s
    if (r1 === r2) {
      heroCell = r1 + r1
    } else {
      const i1 = RANKS.indexOf(r1), i2 = RANKS.indexOf(r2)
      heroCell = i1 < i2
        ? (s1 === s2 ? r1+r2+'s' : r1+r2+'o')
        : (s1 === s2 ? r2+r1+'s' : r2+r1+'o')
    }
  }

  let html = '<div class="rgrid">'
  for (let i = 0; i < 13; i++) {
    for (let j = 0; j < 13; j++) {
      const hand = i === j
        ? RANKS[i]+RANKS[i]
        : j > i
          ? RANKS[i]+RANKS[j]+'s'
          : RANKS[j]+RANKS[i]+'o'
      const inV = VS.has(hand)
      const inB = BS.has(hand)
      let cls = 'rg' + (inV && !inB ? ' rv' : inB ? ' rs' : ' rn')
      if (heroCell && hand === heroCell) cls += ' hh'
      html += `<div class="${cls}" title="${hand}"></div>`
    }
  }
  return html + '</div>'
}

// ─────────────────────────────────────────────────────────────
// DEEP STACK RANGES (40BB+)
// Single tier covers 40BB, 60-75BB, and 100BB+
// Loose defaults where GTO ≥ 50% supports calling
// ─────────────────────────────────────────────────────────────
export const DEEP_RANGES: Record<Position, RangeSet> = {

  // ── UTG ──────────────────────────────────────────────────
  UTG: {
    rfi: [
      // Pairs: 44+
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44',
      // Suited: Ax down to A9s, strong broadways, T9s
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','QJs','JTs','T9s',
      // Offsuit: QJo and above
      'AKo','AQo','AJo','KQo','QJo',
    ],
    vsRaiseCall: [
      // Tight UTG cold-call range — set mining without implied odds is -EV
      'TT','JJ','QQ',
      'AKs','AQs','AJs',
      'KQs',
      'AKo','AQo',
    ],
    threebet: [
      // Value: QQ+ (3-bet/4-bet blocker play)
      'AA','KK','QQ',
      // Bluffs: suited ace blockers ONLY
      'AKs','AQs','A5s','A4s',
      // Offsuit
      'AKo',
    ],
    vs3betCall: [
      // Tight — EP vs 3-bet is a difficult spot
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs',
      'AKo','AQo',
    ],
    fourbet: [
      // Pure value EP — never bluff 4-bet from UTG
      'AA','KK',
      'AKs','A5s',
      'AKo',
    ],
  },

  // ── UTG+1 ────────────────────────────────────────────────
  UTG1: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s',
      'AKo','AQo','AJo','KQo','QJo',
    ],
    vsRaiseCall: [
      // Remove 22-44 — no implied odds for set mining from UTG1
      '55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs','QJs','JTs',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s','A4s',
      'AKo','AQo',
    ],
    vs3betCall: [
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs',
      'AKo','AQo',
    ],
    fourbet: [
      'AA','KK',
      'AKs','A5s',
      'AKo',
    ],
  },

  // ── UTG+2 ────────────────────────────────────────────────
  UTG2: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s',
      'KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s','87s',
      'AKo','AQo','AJo','KQo','QJo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','QJs','JTs','T9s','98s','87s','76s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s','A4s',
      'AKo','AQo',
    ],
    vs3betCall: [
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs',
      'AKo','AQo',
    ],
    fourbet: [
      'AA','KK',
      'AKs','A5s',
      'AKo',
    ],
  },

  // ── LJ ───────────────────────────────────────────────────
  LJ: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s',
      'KQs','KJs','KTs','K9s',
      'QJs','QTs','JTs','T9s','98s','87s','76s',
      'AKo','AQo','AJo','ATo','KQo','KJo','QJo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs',
      'QJs','QTs','JTs','T9s','98s','87s','76s','65s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo','KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs',
      'AKo','AQo','AJo',
    ],
    fourbet: [
      'AA','KK',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
  },

  // ── HJ ───────────────────────────────────────────────────
  HJ: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s',
      'KQs','KJs','KTs','K9s','K8s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','T9s','98s','87s','76s','65s',
      'AKo','AQo','AJo','ATo','KQo','KJo','QJo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs','K9s',
      'QJs','QTs','Q8s',
      'JTs','J9s','T9s','98s','87s','76s','65s','54s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo','KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs',
      'JTs',
      'AKo','AQo','AJo',
    ],
    fourbet: [
      'AA','KK','JJ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
  },

  // ── CO ───────────────────────────────────────────────────
  CO: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
      'KQs','KJs','KTs','K9s','K8s','K7s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','J8s',
      'T9s','T8s','98s','97s','87s','86s','76s','65s','54s',
      'AKo','AQo','AJo','ATo','A9o',
      'KQo','KJo','KTo','QJo','QTo','JTo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s',
      'KQs','KJs','KTs','K9s','K5s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','J8s',
      'T9s','T8s','98s','87s','76s','65s','54s',
      'AKo','AQo','AJo','ATo',
      'KQo','KJo',
    ],
    threebet: [
      'AA','KK','QQ','JJ','99',
      'AKs','AQs','AJs','A9s','A5s','A4s',
      'KQs','KJs',
      'AKo','AQo','AJo',
      'KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','KTs',
      'QJs','JTs',
      'AKo','AQo','AJo',
    ],
    fourbet: [
      'AA','KK','QQ','JJ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
  },

  // ── BTN ──────────────────────────────────────────────────
  BTN: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
      'KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s',
      'QJs','QTs','Q9s','Q8s','Q7s',
      'JTs','J9s','J8s','J7s',
      'T9s','T8s','T7s','98s','97s','87s','86s','76s','75s','65s','64s','54s',
      'AKo','AQo','AJo','ATo','A9o','A8o',
      'KQo','KJo','KTo','K9o',
      'QJo','QTo','JTo','T9o',
    ],
    vsRaiseCall: [
      // Widest call range — position is everything
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s',
      'KQs','KJs','KTs','K9s','K8s','K5s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','J8s',
      'T9s','T8s','T7s','98s','97s','87s','86s','76s','75s','65s','54s','43s',
      'AKo','AQo','AJo','ATo',
      'KQo','KJo',
    ],
    threebet: [
      'AA','KK','QQ','JJ','99','88',
      'AKs','AQs','AJs','A9s','A8s','A5s','A4s',
      'KQs','KJs','KTs',
      'AKo','AQo','AJo',
      'KQo','KJo','QJo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','KTs',
      'QJs','JTs','T9s',
      'AKo','AQo','AJo',
    ],
    fourbet: [
      'AA','KK','QQ','JJ',
      'AKs','AQs','AJs','A5s',
      'AKo','AQo','AJo',
    ],
  },

  // ── SB ───────────────────────────────────────────────────
  // OOP postflop — loose suited, tight offsuit
  SB: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66',
      // Wide suited — only vs BB so position is moot, hand equity matters
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
      'KQs','KJs','KTs','K9s','K8s','K7s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','J8s',
      'T9s','T8s','98s','87s','76s','65s','54s',
      // Offsuit: A8o-ATo only — OOP postflop disadvantage limits KJo/KTo/QJo
      'AKo','AQo','AJo','ATo','A9o','A8o',
      'KQo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A5s','A4s',
      'KQs','KJs','KTs','K9s','K8s','K5s',
      'QJs','QTs','Q9s',
      'JTs','J9s','T9s','T8s','98s','87s','76s','65s','54s',
      'AKo','AQo','AJo','ATo',
      'KQo',
    ],
    threebet: [
      'AA','KK','QQ','JJ','99',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo','AJo',
      'KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs',
      'JTs',
      'AKo','AQo',
    ],
    fourbet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
  },

  // ── BB ───────────────────────────────────────────────────
  // Widest defense — discounted price, last to act preflop
  BB: {
    // BB RFI = vs SB limp only
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','QJs','JTs',
      'AKo','AQo','AJo','KQo',
    ],
    vsRaiseCall: [
      // All pairs — set mining + equity
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      // All suited aces
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
      // Suited kings
      'KQs','KJs','KTs','K9s','K8s','K7s','K6s','K5s',
      // Suited queens
      'QJs','QTs','Q9s','Q8s','Q7s',
      // Suited jacks
      'JTs','J9s','J8s','J7s',
      // All suited connectors and one-gappers — CALL not 3-bet
      'T9s','T8s','T7s','98s','97s','87s','86s','76s','75s','65s','64s','54s','53s','43s',
      // Offsuit — A7o+, connected broadways
      'AKo','AQo','AJo','ATo','A9o','A8o','A7o',
      'KQo','KJo','KTo',
      'QJo','QTo','JTo','T9o','98o','87o',
    ],
    threebet: [
      // Value only + blocker bluffs — NO suited connectors
      'AA','KK','QQ','JJ',
      // Blocker bluffs: suited aces only
      'AKs','AQs','A5s','A4s','A3s',
      // Offsuit
      'AKo','AQo',
      'KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs',
      'JTs','T9s',
      'AKo','AQo','AJo',
    ],
    fourbet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
  },
}

// ─────────────────────────────────────────────────────────────
// MID STACK RANGES (25-35BB)
// Key changes vs deep:
//   - Drop small pairs from EP/MP (no implied odds for set mining)
//   - Drop weak suited connectors from EP/MP
//   - Tighten SB significantly (OOP + committed stack = trap)
//   - 3-bets are near-commits — tighten vs3betCall
//   - BTN barely changes — position value doesn't shrink
// ─────────────────────────────────────────────────────────────
export const MID_RANGES: Record<Position, RangeSet> = {

  UTG: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','QJs','JTs',
      'AKo','AQo','AJo','KQo',
    ],
    vsRaiseCall: [
      // Drop 22-44 — no implied odds at 25-35BB for set mining
      '55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs','JTs','T9s',
      'AKo','AQo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s',
      'AKo',
    ],
    vs3betCall: [
      // 3-bets are commits at this depth — call only premiums
      '77','88','99','TT','JJ','QQ',
      'AKs','AQs',
      'AKo',
    ],
    fourbet: ['AA','KK','AKs','AKo'],
  },

  UTG1: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs','QJs','JTs','T9s',
      'AKo','AQo','AJo','KQo',
    ],
    vsRaiseCall: [
      '55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs','JTs','T9s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
    vs3betCall: [
      '66','77','88','99','TT','JJ','QQ',
      'AKs','AQs',
      'AKo',
    ],
    fourbet: ['AA','KK','AKs','AKo'],
  },

  UTG2: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs','QJs','JTs','T9s',
      'AKo','AQo','AJo','KQo',
    ],
    vsRaiseCall: [
      '44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs','JTs','T9s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
    vs3betCall: [
      '55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs',
      'AKo',
    ],
    fourbet: ['AA','KK','AKs','AKo'],
  },

  LJ: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s',
      'KQs','KJs','KTs','QJs','QTs','JTs','T9s','98s',
      'AKo','AQo','AJo','KQo','KJo',
    ],
    vsRaiseCall: [
      '44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','JTs','T9s','98s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','A5s','A4s',
      'KQs',
      'AKo','AQo',
    ],
    vs3betCall: [
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs',
      'AKo','AQo',
    ],
    fourbet: ['AA','KK','AKs','AQs','A5s','AKo'],
  },

  HJ: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A5s',
      'KQs','KJs','KTs','K9s',
      'QJs','QTs','JTs','J9s','T9s','98s','87s',
      'AKo','AQo','AJo','ATo','KQo','KJo',
    ],
    vsRaiseCall: [
      '33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','JTs','T9s','98s','87s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo',
    ],
    vs3betCall: [
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs',
      'AKo','AQo',
    ],
    fourbet: ['AA','KK','AKs','AQs','A5s','AKo','AQo'],
  },

  CO: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s',
      'KQs','KJs','KTs','K9s',
      'QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s','76s',
      'AKo','AQo','AJo','ATo','KQo','KJo','KTo','QJo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs','KTs',
      'QJs','JTs','T9s','98s','87s','76s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ','99',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo','AJo',
    ],
    vs3betCall: [
      '33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs',
      'KQs',
      'AKo','AQo',
    ],
    fourbet: ['AA','KK','QQ','AKs','AQs','A5s','AKo','AQo'],
  },

  BTN: {
    // BTN barely tightens at 25-35BB — position value is constant
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s',
      'KQs','KJs','KTs','K9s','K8s',
      'QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s','76s','65s',
      'AKo','AQo','AJo','ATo','A9o',
      'KQo','KJo','KTo','QJo','QTo','JTo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s','A8s',
      'KQs','KJs','KTs','K5s',
      'QJs','JTs','T9s','98s','87s','76s','65s',
      'AKo','AQo','AJo',
    ],
    threebet: [
      'AA','KK','QQ','JJ','99',
      'AKs','AQs','AJs','A5s','A4s',
      'KQs',
      'AKo','AQo','AJo',
      'KQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs',
      'KQs',
      'AKo','AQo',
    ],
    fourbet: ['AA','KK','QQ','JJ','AKs','AQs','A5s','AKo','AQo'],
  },

  SB: {
    // Tighten significantly — OOP with committed stack is a trap
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66',
      'AKs','AQs','AJs','ATs','A9s','A8s','A5s',
      'KQs','KJs','KTs',
      'QJs','JTs','T9s',
      // Very tight offsuit — A8o-AJo only
      'AKo','AQo','AJo',
      'KQo',
    ],
    vsRaiseCall: [
      '22','33','44','55','66','77','88','99','TT','JJ',
      'AKs','AQs','AJs','ATs','A9s',
      'KQs','KJs',
      'QJs','JTs','T9s','98s',
      'AKo','AQo',
    ],
    threebet: [
      'AA','KK','QQ','JJ',
      'AKs','AQs','A5s',
      'AKo','AQo',
    ],
    vs3betCall: [
      '44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs',
      'AKo',
    ],
    fourbet: ['AA','KK','AKs','AKo'],
  },

  BB: {
    rfi: [
      'AA','KK','QQ','JJ','TT','99','88','77','66','55',
      'AKs','AQs','AJs','ATs',
      'KQs','KJs','QJs','JTs',
      'AKo','AQo','AJo','KQo',
    ],
    vsRaiseCall: [
      // Still defend wide — pot odds are good
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs','ATs','A9s','A8s','A7s','A5s','A4s','A3s',
      'KQs','KJs','KTs','K9s','K8s',
      'QJs','QTs','Q9s','Q8s',
      'JTs','J9s','J8s',
      'T9s','T8s','98s','87s','76s','65s','54s',
      'AKo','AQo','AJo','ATo',
      'KQo','KJo',
    ],
    threebet: [
      'AA','KK','QQ','JJ',
      'AKs','AQs','A5s','A4s',
      // Suited connectors CALL — do not 3-bet
      'AKo','AQo',
    ],
    vs3betCall: [
      '22','33','44','55','66','77','88','99','TT','JJ','QQ',
      'AKs','AQs','AJs',
      'AKo','AQo',
    ],
    fourbet: ['AA','KK','QQ','AKs','AQs','A5s','AKo','AQo'],
  },
}

// ─────────────────────────────────────────────────────────────
// SHOVE / FOLD RANGES (<20BB)
// NEVER open-raise-fold at any depth below 20BB
// These are shove-first-in ranges and call-a-shove ranges
// ─────────────────────────────────────────────────────────────
export const SHOVE_RANGES: Record<ShoveTier, Record<Position, PushFoldRange>> = {

  '15_19BB': {
    UTG: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo','AJs','AJo','ATs','KQs','KQo'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo','AQs','AQo'],
    },
    UTG1: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','KQs','KQo','KJs'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo','AQs'],
    },
    UTG2: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','KQs','KQo','KJs','KTs','QJs'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo','AQs'],
    },
    LJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','KQs','KQo','KJs','KTs','QJs','JTs'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs'],
    },
    HJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','JTs','T9s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs','AQo'],
    },
    CO: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','98s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo'],
    },
    BTN: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','QJs','QTs','Q9s','Q8s','JTs','J9s','T9s','T8s','98s','87s','76s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo','AJs'],
    },
    SB: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs','AQo'],
    },
    BB: {
      shove:     [],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A5s','KQs','KQo','KJs','QJs'],
    },
  },

  '10_14BB': {
    UTG: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','KQs','KQo','KJs','KTs','QJs','JTs'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo','AQs'],
    },
    UTG1: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','JTs','T9s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo','AQs'],
    },
    UTG2: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','JTs','J9s','T9s','98s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs'],
    },
    LJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs','AQo'],
    },
    HJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','Q8s','JTs','J9s','T9s','98s','87s','76s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo'],
    },
    CO: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','QJs','QTs','Q9s','Q8s','JTs','J9s','J8s','T9s','T8s','98s','87s','76s','65s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo','AJs'],
    },
    BTN: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','K6s','QJs','QTs','Q9s','Q8s','Q7s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','86s','76s','65s','54s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AKo','AQs','AQo','AJs'],
    },
    SB: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','Q8s','JTs','J9s','T9s','T8s','98s','87s','76s','65s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo'],
    },
    BB: {
      shove:     [],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A5s','A4s','KQs','KQo','KJs','KTs','QJs','JTs','T9s'],
    },
  },

  'under_10BB': {
    UTG: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','JTs','T9s','98s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo'],
    },
    UTG1: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','AKs','AKo'],
    },
    UTG2: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','QJs','QTs','Q9s','JTs','J9s','T9s','98s','87s','76s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo'],
    },
    LJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','QJs','QTs','Q9s','Q8s','JTs','J9s','T9s','T8s','98s','87s','76s','65s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','AKs','AKo','AQs'],
    },
    HJ: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','K6s','QJs','QTs','Q9s','Q8s','Q7s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s','65s','54s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs'],
    },
    CO: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','JTs','J9s','J8s','T9s','T8s','T7s','98s','97s','87s','86s','76s','65s','54s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo'],
    },
    BTN: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','K6s','K5s','K4s','K3s','K2s','QJs','QTs','Q9s','Q8s','Q7s','Q6s','JTs','J9s','J8s','J7s','T9s','T8s','T7s','98s','97s','87s','86s','76s','75s','65s','64s','54s','53s','43s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','66','AKs','AKo','AQs','AQo','AJs'],
    },
    SB: {
      shove:     ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','22','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A7s','A6s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','K8s','K7s','K6s','K5s','QJs','QTs','Q9s','Q8s','Q7s','JTs','J9s','J8s','T9s','T8s','98s','97s','87s','76s','65s','54s'],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','AKs','AKo','AQs','AQo'],
    },
    BB: {
      shove:     [],
      callShove: ['AA','KK','QQ','JJ','TT','99','88','77','66','55','44','33','AKs','AKo','AQs','AQo','AJs','AJo','ATs','A9s','A8s','A5s','A4s','A3s','A2s','KQs','KQo','KJs','KTs','K9s','QJs','QTs','JTs','T9s','98s','87s'],
    },
  },
}

// ─────────────────────────────────────────────────────────────
// LOOKUP HELPERS
// Used by scenarios.ts and useGameState.ts
// ─────────────────────────────────────────────────────────────

export function getRanges(
  pos: Position,
  stackBB: number
): RangeSet {
  if (stackBB >= 25) return DEEP_RANGES[pos]
  return MID_RANGES[pos]
}

export function getShoveRanges(
  pos: Position,
  stackBB: number
): PushFoldRange {
  const tier: ShoveTier =
    stackBB >= 15 ? '15_19BB' :
    stackBB >= 10 ? '10_14BB' :
    'under_10BB'
  return SHOVE_RANGES[tier][pos]
}

export function isInRFI(hand: string, pos: Position, stackBB: number): boolean {
  return getRanges(pos, stackBB).rfi.includes(hand)
}

export function isInShoveRange(hand: string, pos: Position, stackBB: number): boolean {
  return getShoveRanges(pos, stackBB).shove.includes(hand)
}

export function isCallableShove(hand: string, pos: Position, stackBB: number): boolean {
  return getShoveRanges(pos, stackBB).callShove.includes(hand)
}

// BB defense frequency by opener position (GTO Wizard MTT)
export const BB_DEFENSE_FREQ: Record<string, number> = {
  BTN: 58.5,
  SB:  54.0,
  CO:  46.5,
  HJ:  37.5,
  LJ:  33.0,
  UTG2: 28.0,
  UTG1: 25.5,
  UTG:  23.8,
}
