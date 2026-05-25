'use client'

import { useEffect, useState } from 'react'
import { useGameState } from '../../hooks/useGameState'
import { QSCORE, QLABEL } from '../../types'
import { getBB, getSB, getAnte, getBBDepth, getDay, HANDS_PER_LEVEL, TOTAL_LEVELS, TOTAL_PLAYERS } from '../../engine/tournamentStructure'
import type { HeroOption } from '../../engine/handEngine'
import { evalHand } from '../../engine/handEval'

const fmt  = (n: number): string => n >= 1_000_000 ? (n/1_000_000).toFixed(1)+'M' : n >= 1_000 ? Math.round(n/1_000)+'k' : n.toLocaleString()
const fmtF = (n: number): string => n.toLocaleString()
const isRed = (s: string) => s === '♥' || s === '♦'
const TOTAL_HANDS = TOTAL_LEVELS * HANDS_PER_LEVEL

const Q_COLOR: Record<string, string> = {
  best: '#3fb950', good: '#1f6feb', ok: '#d4a843', bad: '#f85149',
}
const Q_BG: Record<string, string> = {
  best: '#0d2818', good: '#0d1f3d', ok: '#2d2200', bad: '#2d0d0d',
}
const Q_BORDER: Record<string, string> = {
  best: 'rgba(63,185,80,0.30)', good: 'rgba(31,111,235,0.30)',
  ok: 'rgba(212,168,67,0.30)', bad: 'rgba(248,81,73,0.30)',
}

// ── Card ──────────────────────────────────────────────────────
function Card({ r, s, size = 'md', faceDown = false }: {
  r: string; s: string; size?: 'xs' | 'sm' | 'md' | 'lg'; faceDown?: boolean
}) {
  const dims = {
    xs: 'w-5 h-7 text-[9px]',
    sm: 'w-7 h-10 text-xs',
    md: 'w-9 h-13 text-sm',
    lg: 'w-12 h-17 text-base',
  }
  if (faceDown) {
    return (
      <div className={`${dims[size]} rounded border border-[#2a4a6b] shadow flex-shrink-0`}
        style={{
          background: 'repeating-linear-gradient(45deg,#1a2d4a,#1a2d4a 3px,#1e3557 3px,#1e3557 8px)',
        }} />
    )
  }
  return (
    <div className={`${dims[size]} rounded bg-white border border-stone-200 flex items-center justify-center font-bold shadow-md flex-shrink-0`}
      style={{ color: isRed(s) ? '#cc2222' : '#111' }}>
      {r}{s}
    </div>
  )
}

// ── Quality Badge ─────────────────────────────────────────────
function QBadge({ q, small }: { q: string; small?: boolean }) {
  const fg = (q === 'best') ? '#0d2818' : (q === 'ok') ? '#0d0d0d' : '#ffffff'
  return (
    <span className={`font-bold rounded px-2 py-0.5 ${small ? 'text-[9px]' : 'text-[10px]'}`}
      style={{ background: Q_COLOR[q], color: fg }}>
      {QLABEL[q as keyof typeof QLABEL]}
    </span>
  )
}

// ── Bet Chip ──────────────────────────────────────────────────
function BetChip({ amount, leftPct, topPct, compact }: {
  amount: number
  leftPct: number
  topPct: number
  compact: boolean
}) {
  const chipSize = compact ? 16 : 20
  return (
    <div className="absolute flex flex-col items-center"
      style={{ left: `${leftPct}%`, top: `${topPct}%`, transform: 'translate(-50%, -50%)', zIndex: 25 }}>
      <div className="rounded-full border-2 flex items-center justify-center"
        style={{
          width: chipSize, height: chipSize,
          background: 'linear-gradient(135deg, #d4a843, #8b6914)',
          borderColor: '#f0c040',
          boxShadow: '0 2px 4px rgba(0,0,0,0.5), inset 0 1px rgba(255,255,255,0.2)',
        }}>
        <div className="rounded-full"
          style={{
            width: chipSize * 0.5, height: chipSize * 0.5,
            background: 'rgba(255,255,255,0.15)',
            border: '1px solid rgba(255,255,255,0.3)',
          }} />
      </div>
      <div className="text-[#d4a843] font-bold font-mono mt-0.5"
        style={{ fontSize: compact ? 7 : 9 }}>
        {amount.toLocaleString()}
      </div>
    </div>
  )
}

// ── Table Visual ──────────────────────────────────────────────
function TableVisual({ engine, heroSeatIndex, compact = false }: {
  engine: NonNullable<ReturnType<typeof useGameState>['state']['engine']>
  heroSeatIndex: number
  compact?: boolean
}) {
  const seats = engine.seats
  const heroSeat = seats[heroSeatIndex]
  const height = compact ? 180 : 340

  const ellipsePositions = [
    { top: '88%', left: '50%' },
    { top: '74%', left: '82%' },
    { top: '48%', left: '96%' },
    { top: '18%', left: '84%' },
    { top: '5%',  left: '64%' },
    { top: '5%',  left: '36%' },
    { top: '18%', left: '16%' },
    { top: '48%', left: '4%'  },
    { top: '74%', left: '18%' },
  ]

  // Bet chip % coords: interpolate 40% from seat toward table center
  const betChipPositions = ellipsePositions.map(p => {
    const sL = parseFloat(p.left)
    const sT = parseFloat(p.top)
    return { leftPct: sL + (50 - sL) * 0.40, topPct: sT + (50 - sT) * 0.40 }
  })

  const ACTION_ORDER = ['UTG', 'UTG1', 'UTG2', 'LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB']
  const heroPos = heroSeat?.position ?? 'BB'
  const heroActionIdx = ACTION_ORDER.indexOf(heroPos)

  const orderedSeats = [
    heroSeat!,
    ...Array.from({ length: 8 }, (_, k) => {
      const targetPos = ACTION_ORDER[(heroActionIdx - (k + 1) + 9) % 9]
      return seats.find(s => s.position === targetPos) ?? heroSeat!
    }),
  ]

  const cardSize = compact ? 'xs' : 'md'

  return (
    <div className="relative w-full mx-auto select-none" style={{ height }}>
      {/* Felt */}
      <div className="absolute rounded-[50%]"
        style={{
          top: '6%', left: '5%', right: '5%', bottom: '2%',
          background: 'radial-gradient(ellipse at 40% 35%, #1a5c28 0%, #0f3d17 60%, #071a0a 100%)',
          border: '4px solid #2d6b30',
          boxShadow: 'inset 0 3px 16px rgba(0,0,0,0.7), 0 0 20px rgba(45,107,48,0.30), 0 0 0 1px #0a1a0b',
        }} />

      {/* Rail highlight */}
      <div className="absolute rounded-[50%] pointer-events-none"
        style={{
          top: '5%', left: '4.5%', right: '4.5%', bottom: '1.5%',
          border: '1px solid rgba(255,255,255,0.08)',
        }} />

      {/* WSOP felt branding */}
      <div className="absolute pointer-events-none"
        style={{
          top: '50%', left: '50%',
          transform: 'translate(-50%, -50%)',
          marginTop: compact ? -8 : -12,
          zIndex: 5,
        }}>
        <svg width={compact ? 120 : 200} height={compact ? 40 : 65}
          viewBox="0 0 200 65" fill="none" opacity="0.10">
          <text x="100" y="18" textAnchor="middle"
            fontSize="9" fontWeight="600" fontFamily="serif"
            fill="white" letterSpacing="4">WORLD SERIES OF POKER</text>
          <text x="100" y="40" textAnchor="middle"
            fontSize="22" fontWeight="900" fontFamily="serif"
            fill="white" letterSpacing="8">WSOP</text>
          <text x="100" y="56" textAnchor="middle"
            fontSize="8" fontWeight="400" fontFamily="serif"
            fill="white" letterSpacing="5">MAIN EVENT</text>
        </svg>
      </div>

      {/* Center: Pot + board */}
      <div className="absolute z-10 flex flex-col items-center gap-1"
        style={{ top: '28%', left: '50%', transform: 'translate(-50%, -50%)' }}>
        <div className="text-[#d4a843] font-['Syne'] font-bold tracking-wide flex items-center gap-1.5"
          style={{ fontSize: compact ? 9 : 13 }}>
          <div className="flex flex-col -space-y-1">
            {[0, 1, 2].map(i => (
              <div key={i} className="rounded-full border"
                style={{
                  width: compact ? 8 : 10,
                  height: compact ? 4 : 5,
                  background: i === 0 ? '#d4a843' : i === 1 ? '#e6edf3' : '#3fb950',
                  borderColor: 'rgba(0,0,0,0.3)',
                }} />
            ))}
          </div>
          <span>POT {fmtF(engine.pot)}</span>
        </div>
        {engine.board.length > 0 && (
          <div className="flex gap-0.5" style={{ filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.7))' }}>
            {engine.board.map((c, i) => <Card key={i} r={c.r} s={c.s} size={cardSize} />)}
          </div>
        )}
      </div>

      {/* Seats */}
      {orderedSeats.map((seat, posIdx) => {
        const pos = ellipsePositions[posIdx]
        const isHero = seat.seatIndex === heroSeatIndex
        const isActive = !seat.folded

        return (
          <div key={seat.seatIndex} className="absolute z-20"
            style={{ top: pos.top, left: pos.left, transform: 'translate(-50%, -50%)' }}>
            <div className="relative">

            {isHero ? (
              <div className="flex flex-col items-center gap-0.5">
                <div className="flex gap-0.5" style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))' }}>
                  {(engine.currentDecision?.heroCards ?? engine.heroSeat.holeCards)?.map((c, i) => (
                    <Card key={i} r={c.r} s={c.s} size={cardSize} />
                  ))}
                </div>
                <div className="rounded-full px-2.5 py-1 text-center whitespace-nowrap"
                  style={{ background: 'rgba(22,27,34,0.92)', border: '1px solid rgba(212,168,67,0.60)' }}>
                  <div className="text-[#d4a843] font-bold font-['Syne'] leading-none" style={{ fontSize: compact ? 11 : 14 }}>
                    {seat.position}
                  </div>
                  <div className="text-[#8b949e] leading-none" style={{ fontSize: compact ? 9 : 11 }}>
                    {fmt(seat.stack)}
                  </div>
                </div>
                {seat.position === 'BTN' && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full
                    flex items-center justify-center text-[6px] font-bold z-30"
                    style={{ background: '#e6edf3', color: '#0d1117', border: '1px solid #d4a843',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
                    D
                  </div>
                )}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-0.5">
                {/* Cards — visible only when active, faded when folded */}
                <div style={{ opacity: isActive ? 1 : 0.25 }}>
                  {isActive ? (
                    <div className="flex gap-0.5">
                      <Card r="?" s="" size={cardSize} faceDown />
                      <Card r="?" s="" size={cardSize} faceDown />
                    </div>
                  ) : (
                    <div style={{ height: compact ? 18 : 32 }} />
                  )}
                </div>
                {/* Position label + stack — always full opacity */}
                <div className="text-center rounded-full px-2.5 py-1 whitespace-nowrap"
                  style={{ background: 'rgba(22,27,34,0.90)', border: '1px solid #30363d' }}>
                  <div className="font-bold font-['Syne'] leading-none"
                    style={{ fontSize: compact ? 11 : 14, color: isActive ? '#d4a843' : '#6b7280' }}>
                    {seat.position}
                  </div>
                  <div className="leading-none" style={{ fontSize: compact ? 9 : 11, color: '#484f58' }}>
                    {fmt(seat.stack)}
                  </div>
                </div>
                {seat.position === 'BTN' && (
                  <div className="absolute -top-1 -right-1 w-4 h-4 rounded-full
                    flex items-center justify-center text-[6px] font-bold z-30"
                    style={{ background: '#e6edf3', color: '#0d1117', border: '1px solid #30363d',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
                    D
                  </div>
                )}
              </div>
            )}
            </div>
          </div>
        )
      })}

      {/* Bet chips on felt */}
      {orderedSeats.map((seat, posIdx) => {
        if (seat.invested <= 0) return null
        if (seat.folded) return null
        const { leftPct, topPct } = betChipPositions[posIdx]
        return (
          <BetChip
            key={`bet-${seat.seatIndex}`}
            amount={seat.invested}
            leftPct={leftPct}
            topPct={topPct}
            compact={compact}
          />
        )
      })}
    </div>
  )
}

// ── Hand Strength Meter ───────────────────────────────────────
function HandMeter({ heroCards, board, heroPos, bb: _bb, heroStack: _heroStack }: {
  heroCards: [{ r: string; s: string }, { r: string; s: string }] | null
  board: { r: string; s: string }[]
  heroPos?: string
  bb?: number
  heroStack?: number
}) {
  if (!heroCards) return null

  // ── PREFLOP: categorize hand strength by position ────────
  if (board.length === 0) {
    const RANK_ORDER = 'AKQJT98765432'.split('')
    const r1 = heroCards[0].r, r2 = heroCards[1].r
    const s1 = heroCards[0].s, s2 = heroCards[1].s
    const i1 = RANK_ORDER.indexOf(r1), i2 = RANK_ORDER.indexOf(r2)
    const [hi, lo, hiS, loS] = i1 <= i2
      ? [r1, r2, s1, s2] : [r2, r1, s2, s1]
    const isPair = hi === lo
    const isSuited = hiS === loS
    const handStr = isPair ? `${hi}${lo}` : `${hi}${lo}${isSuited ? 's' : 'o'}`

    const hiIdx = RANK_ORDER.indexOf(hi)
    const loIdx = RANK_ORDER.indexOf(lo)
    const gap = loIdx - hiIdx

    const pairPct    = Math.round(Math.min(95, 50 + (13 - hiIdx) * 3.5))
    const suitedPct  = Math.round(Math.min(95, 30 + (13 - hiIdx) * 2))
    const offsuitPct = Math.round(Math.min(95, 20 + (13 - hiIdx) * 1.5))

    type Tier = { label: string; color: string; pct: number }

    const tier: Tier = (() => {
      if (isPair && hiIdx <= 3)
        return { label: 'Premium Pair',      color: '#f39c12', pct: pairPct }
      if (handStr === 'AKs' || handStr === 'AKo')
        return { label: 'Big Slick',         color: '#f39c12', pct: suitedPct }
      if (isPair && hiIdx <= 6)
        return { label: 'Medium Pair',       color: '#3fb950', pct: pairPct }
      if (['AQs','AJs','AQo','KQs'].includes(handStr))
        return { label: 'Broadway Hand',     color: '#3fb950', pct: isSuited ? suitedPct : offsuitPct }
      if (isPair)
        return { label: 'Small Pair',        color: '#1f6feb', pct: pairPct }
      if (isSuited && gap <= 2 && hiIdx <= 8)
        return { label: 'Suited Connector',  color: '#1f6feb', pct: suitedPct }
      if (isSuited && hi === 'A')
        return { label: 'Suited Ace',        color: '#1f6feb', pct: suitedPct }
      if (isSuited && hiIdx <= 5 && gap <= 3)
        return { label: 'Suited Broadway',   color: '#1f6feb', pct: suitedPct }
      if (!isSuited && gap <= 2 && hiIdx <= 7)
        return { label: 'Offsuit Connector', color: '#d4a843', pct: offsuitPct }
      if (isSuited && gap <= 4 && hiIdx <= 9)
        return { label: 'Weak Suited',       color: '#d4a843', pct: suitedPct }
      return   { label: 'High Card',         color: '#f85149', pct: offsuitPct }
    })()

    return (
      <div className="bg-[#161b22] rounded-xl border border-[#30363d] px-3 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] text-[#484f58] uppercase tracking-widest font-['Syne']">
            Hand Strength
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#484f58]">{heroPos ?? ''}</span>
            <span className="text-[12px] font-semibold" style={{ color: tier.color }}>
              {tier.label}
            </span>
          </div>
        </div>
        <div className="w-full h-2 bg-[#30363d] rounded-full overflow-hidden">
          <div className="h-full rounded-full transition-all duration-300"
            style={{
              width: `${tier.pct}%`,
              background: `linear-gradient(90deg, #484f58, ${tier.color})`,
            }} />
        </div>
      </div>
    )
  }

  // ── POSTFLOP: existing logic ─────────────────────────────
  const hs = evalHand(
    { r: heroCards[0].r, s: heroCards[0].s },
    { r: heroCards[1].r, s: heroCards[1].s },
    board as { r: string; s: string }[]
  )

  const barColor =
    hs.str >= 5 ? '#f39c12' :
    hs.str >= 3 ? '#3fb950' :
    hs.str >= 2 ? '#1f6feb' :
    hs.str === 1 ? '#8b949e' :
    '#484f58'

  const drawNote = hs.heroFD && hs.oesd ? ' + combo draw' :
    hs.heroNFD ? ' + nut flush draw' :
    hs.heroFD ? ' + flush draw' :
    hs.oesd ? ' + open-ender' :
    hs.gut ? ' + gutshot' :
    hs.overcards > 0 ? ` + ${hs.overcards} overcard${hs.overcards > 1 ? 's' : ''}` :
    ''

  const barPct = Math.round((hs.str / 7) * 100)

  return (
    <div className="bg-[#161b22] rounded-xl border border-[#30363d] px-3 py-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[9px] text-[#484f58] uppercase tracking-widest font-['Syne']">
          Your Hand
        </span>
        <span className="text-[12px] font-semibold" style={{ color: barColor }}>
          {hs.label}{drawNote}
        </span>
      </div>
      <div className="w-full h-2 bg-[#30363d] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-300"
          style={{
            width: `${Math.max(5, barPct)}%`,
            background: `linear-gradient(90deg, #3fb950, ${barColor})`,
          }} />
      </div>
    </div>
  )
}

// ── Action Button ─────────────────────────────────────────────
function ActionBtn({ opt, pot, onClick, disabled }: {
  opt: HeroOption; pot: number; onClick: () => void; disabled?: boolean
}) {
  const pct = pot > 0 && opt.chipCost > 0
    ? Math.round(opt.chipCost / pot * 100)
    : 0

  type BtnStyle = { bg: string; border: string; text: string; hover: string }
  const colors: Record<string, BtnStyle> = {
    fold:  { bg: '#3d1a1a', border: 'rgba(248,81,73,0.40)',   text: '#f85149', hover: '#4d2020' },
    call:  { bg: '#1a3d2a', border: 'rgba(63,185,80,0.40)',   text: '#3fb950', hover: '#1e4d33' },
    limp:  { bg: '#1c2128', border: 'rgba(139,148,158,0.30)', text: '#e6edf3', hover: '#21282f' },
    check: { bg: '#1c2128', border: 'rgba(139,148,158,0.30)', text: '#e6edf3', hover: '#21282f' },
    raise: { bg: '#3d2f0a', border: 'rgba(212,168,67,0.40)',  text: '#d4a843', hover: '#4d3c0d' },
    shove: { bg: '#3d2000', border: 'rgba(240,136,62,0.40)',  text: '#f0883e', hover: '#4d2800' },
  }
  const c = colors[opt.type as keyof typeof colors] ?? colors.check

  return (
    <button onClick={onClick} disabled={disabled}
      className="w-full rounded-xl px-4 py-4 text-left active:scale-[0.98] transition-all duration-150"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
      onMouseEnter={e => { e.currentTarget.style.background = c.hover }}
      onMouseLeave={e => { e.currentTarget.style.background = c.bg }}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-[14px]" style={{ color: c.text }}>{opt.label}</span>
        {opt.chipCost > 0 && (
          <span className="text-[12px] opacity-70 shrink-0" style={{ color: c.text }}>
            {fmtF(opt.chipCost)}
          </span>
        )}
      </div>
      {opt.chipCost > 0 && pct > 0 && (
        <div className="text-[11px] mt-0.5 opacity-50" style={{ color: c.text }}>
          {pct}% pot
        </div>
      )}
    </button>
  )
}

// ── Street History Entry ──────────────────────────────────────
function StreetEntry({ street, action, chipDelta, board, preDesc, postDesc }: {
  street: string
  action: HeroOption
  chipDelta: number
  board: { r: string; s: string }[]
  preDesc?: string
  postDesc?: string
}) {
  return (
    <div className="border-l-2 pl-2.5 py-1.5" style={{ borderColor: Q_COLOR[action.quality] }}>
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[9px] font-bold uppercase tracking-widest font-['Syne'] text-[#d4a843]">
          {street}
        </span>
        {board.length > 0 && (
          <div className="flex gap-0.5">
            {board.map((c, i) => <Card key={i} r={c.r} s={c.s} size="xs" />)}
          </div>
        )}
      </div>
      {preDesc && (
        <div className="text-[#484f58] text-[9px] leading-snug mb-1">{preDesc}</div>
      )}
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className="text-[#e6edf3] text-[10px] font-medium">You: {action.label}</span>
        <QBadge q={action.quality} small />
        <span className={`text-[10px] font-bold ml-auto ${chipDelta < 0 ? 'text-[#f85149]' : chipDelta > 0 ? 'text-[#3fb950]' : 'text-[#484f58]'}`}>
          {chipDelta > 0 ? '+' : ''}{fmtF(chipDelta)}
        </span>
      </div>
      {postDesc && (
        <div className="text-[#484f58] text-[9px] leading-snug">{postDesc}</div>
      )}
    </div>
  )
}

// ── Left Panel (desktop) ──────────────────────────────────────
function LeftPanel({ state, bb, sb, ante, day, bbDepth, nearBubble }: {
  state: ReturnType<typeof useGameState>['state']
  bb: number; sb: number; ante: number; day: number; bbDepth: number; nearBubble: boolean
}) {
  const { levelIndex, playersLeft, heroStack, heroStackBefore, totalHands,
    sessionScore, sessionMaxScore, streetResults } = state
  const handNum = totalHands + 1
  const scorePct = sessionMaxScore > 0 ? Math.round(sessionScore / sessionMaxScore * 100) : 0

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto">
      {/* Tournament info */}
      <div className="bg-[#161b22] rounded-xl border border-[#30363d] p-3">
        <div className="text-[#d4a843] font-['Syne'] font-bold text-xs mb-2.5">♠ WSOP Main Event</div>
        <div className="space-y-1.5">
          {([
            ['Day', `${day} · Level ${levelIndex + 1}`],
            ['Blinds', `${fmtF(sb)}/${fmtF(bb)}`],
            ['Ante', fmtF(ante)],
            ['Players', `${playersLeft.toLocaleString()} / ${TOTAL_PLAYERS.toLocaleString()}`],
            ['Stack', fmtF(heroStack)],
            ['Depth', `${bbDepth}BB`],
            ['Hand', `${handNum} / ${TOTAL_HANDS}`],
          ] as [string, string][]).map(([label, val]) => (
            <div key={label} className="flex justify-between items-baseline">
              <span className="text-[#8b949e] text-[11px]">{label}</span>
              <span className="text-[#e6edf3] text-[12px] font-medium">{val}</span>
            </div>
          ))}
        </div>
        {nearBubble && (
          <div className="mt-2 text-[10px] text-[#d4a843] rounded-lg px-2 py-1.5"
            style={{ background: 'rgba(212,168,67,0.10)', border: '1px solid rgba(212,168,67,0.20)' }}>
            ★ {(playersLeft - 2160).toLocaleString()} from money
          </div>
        )}
        {bbDepth < 15 && (
          <div className="mt-2 text-[10px] text-[#f85149] rounded-lg px-2 py-1.5"
            style={{ background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.20)' }}>
            ⚠ {bbDepth}BB — Shove or fold
          </div>
        )}
      </div>

      {/* Score */}
      <div className="bg-[#161b22] rounded-xl border border-[#30363d] p-3">
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-[#8b949e] text-[10px] uppercase tracking-widest font-['Syne']">Score</span>
          <span className="font-bold text-sm font-['Syne']"
            style={{ color: scorePct >= 80 ? '#3fb950' : scorePct >= 60 ? '#d4a843' : '#f85149' }}>
            {scorePct}%
          </span>
        </div>
        <div className="text-[#e6edf3] font-bold text-lg font-['Syne']">{sessionScore}
          <span className="text-[#484f58] text-xs font-normal"> / {sessionMaxScore} pts</span>
        </div>
        <div className="w-full h-2 bg-[#30363d] rounded-full overflow-hidden mt-2">
          <div className="h-full rounded-full transition-all"
            style={{ width: `${scorePct}%`, background: scorePct >= 80 ? '#3fb950' : scorePct >= 60 ? '#d4a843' : '#f85149' }} />
        </div>
      </div>

      {/* Street history */}
      {streetResults.length > 0 && (
        <div className="bg-[#161b22] rounded-xl border border-[#30363d] p-3">
          <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] font-bold mb-2">
            This Hand
          </div>
          <div className="space-y-2">
            {streetResults.map((r, i) => (
              <StreetEntry key={i} street={r.street} action={r.heroAction}
                chipDelta={r.chipDelta} board={r.board}
                preDesc={r.preDesc} postDesc={r.postDesc} />
            ))}
          </div>
          <div className="mt-2 pt-2 border-t border-[#30363d] flex justify-between text-[10px]">
            <span className="text-[#8b949e]">Net this hand</span>
            {(() => { const net = heroStack - heroStackBefore; return (
              <span className={`font-bold ${net > 0 ? 'text-[#3fb950]' : net < 0 ? 'text-[#f85149]' : 'text-[#484f58]'}`}>
                {net > 0 ? '+' : ''}{fmtF(net)}
              </span>
            ) })()}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Right Panel (desktop playing) ─────────────────────────────
function RightPanelPlaying({ decision, takeAction, pot }: {
  decision: NonNullable<ReturnType<typeof useGameState>['state']['engine']>['currentDecision']
  takeAction: (i: number) => void
  pot: number
}) {
  if (!decision) return null
  return (
    <div className="flex flex-col gap-3">
      <div className="bg-[#161b22] rounded-xl border-l-2 border-[#d4a843] p-3 flex-shrink-0">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[#d4a843] text-[10px] font-bold uppercase tracking-widest font-['Syne']">
            {decision.street.toUpperCase()}
          </span>
          <span className="text-[#e6edf3] text-[11px] font-bold font-['Syne']">
            Pot: {fmtF(decision.pot)}
          </span>
        </div>
        <div className="text-[#8b949e] text-[12px] leading-relaxed">{decision.desc}</div>
      </div>
      <div className="space-y-2 flex-shrink-0">
        <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] font-bold">Your Action</div>
        {decision.options.map((opt, i) => (
          <ActionBtn key={i} opt={opt} pot={decision.pot} onClick={() => takeAction(i)} />
        ))}
      </div>
    </div>
  )
}

// ── Right Panel (desktop outcome) ─────────────────────────────
function RightPanelOutcome({ lastOption, lastDecision, lastChipDelta, engine, continueAfterOutcome, pendingStreetDesc }: {
  lastOption: ReturnType<typeof useGameState>['state']['lastOption']
  lastDecision: ReturnType<typeof useGameState>['state']['lastDecision']
  lastChipDelta: number
  engine: NonNullable<ReturnType<typeof useGameState>['state']['engine']>
  continueAfterOutcome: () => void
  pendingStreetDesc: string
}) {
  if (!lastOption) return null
  const isOver = engine.isOver
  const isPending = engine.pendingAdvance
  const nextStreet = !isOver && !isPending && engine.currentDecision?.street

  const nextLabel = isOver
    ? (engine.showdownSeat ? 'What hand do you put them on? →' : 'See Recap →')
    : isPending
      ? ({ preflop: 'Deal the Flop →', flop: 'Deal the Turn →', turn: 'Deal the River →' } as Record<string, string>)[engine.street] ?? 'Continue →'
      : nextStreet
        ? ({ flop: 'Continue → Flop', turn: 'Continue → Turn', river: 'Continue → River', preflop: 'More Action →' } as Record<string, string>)[nextStreet] ?? 'Continue →'
        : 'See Recap →'

  return (
    <div className="flex flex-col gap-3 h-full overflow-y-auto">
      {/* Coaching card */}
      <div className="rounded-xl border p-3 flex-shrink-0"
        style={{ background: Q_BG[lastOption.quality], borderColor: Q_BORDER[lastOption.quality] }}>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <span className="font-['Syne'] font-bold text-[12px]" style={{ color: Q_COLOR[lastOption.quality] }}>
            {lastOption.quality === 'best' ? '✓ Best play' :
             lastOption.quality === 'bad'  ? '✗ Mistake' :
             lastOption.quality === 'good' ? '◎ Good play' : '△ Okay play'}
          </span>
          <QBadge q={lastOption.quality} />
          <span className="text-[#d4a843] text-[10px] font-['Syne'] ml-auto">+{QSCORE[lastOption.quality]}pts</span>
        </div>
        <div className="text-[#e6edf3] text-[12px] leading-relaxed">{lastOption.coaching}</div>
        {lastDecision && (
          <div className="mt-2 pt-2 border-t border-white/10 text-[10px] text-[#484f58]">
            Pot: {fmtF(lastDecision.pot)}
            {lastOption.chipCost > 0 && ` · Cost: ${fmtF(lastOption.chipCost)}`}
            {lastOption.chipCost > 0 && lastDecision.pot > 0 &&
              ` · Pot odds: ${Math.round(lastOption.chipCost / (lastDecision.pot + lastOption.chipCost) * 100)}%`}
          </div>
        )}
      </div>

      {/* All options */}
      {lastDecision && (
        <div className="bg-[#161b22] rounded-xl border border-[#30363d] p-3 flex-shrink-0">
          <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] font-bold mb-2">All Options</div>
          <div className="space-y-1.5">
            {lastDecision.options.map((opt, i) => (
              <div key={i} className="flex items-center justify-between py-1 px-2 rounded-lg"
                style={{ background: opt.label === lastOption.label ? Q_COLOR[opt.quality] + '15' : 'transparent' }}>
                <span className="text-[#8b949e] text-[11px] truncate mr-2">{opt.label}</span>
                <QBadge q={opt.quality} small />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* After your action — villain responses */}
      {pendingStreetDesc && (
        <div className="rounded-xl border border-[#30363d] p-3 flex-shrink-0"
          style={{ background: '#0d1117' }}>
          <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] font-bold mb-1.5">After your action</div>
          <div className="text-[#8b949e] text-[11px] leading-relaxed">{pendingStreetDesc}</div>
        </div>
      )}

      {/* Chip delta */}
      <div className="bg-[#161b22] rounded-xl border border-[#30363d] p-3 flex-shrink-0">
        <div className="flex justify-between items-center">
          <span className="text-[#8b949e] text-[11px]">Chip result</span>
          <span className={`font-bold font-['Syne'] text-sm ${lastChipDelta < 0 ? 'text-[#f85149]' : lastChipDelta > 0 ? 'text-[#3fb950]' : 'text-[#484f58]'}`}>
            {lastChipDelta > 0 ? '+' : ''}{fmtF(lastChipDelta)}
          </span>
        </div>
      </div>

      <button onClick={continueAfterOutcome}
        className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] flex-shrink-0 transition-colors hover:bg-[#e6b84a]"
        style={{ background: '#d4a843' }}>
        {nextLabel}
      </button>
    </div>
  )
}

// ── Main export ───────────────────────────────────────────────
export default function GamePage() {
  const [selectedMode, setSelectedMode] =
    useState<'full' | 'day1' | 'day2' | 'day3'>('full')
  const [canResume, setCanResume] = useState(false)

  const {
    state, startTournament, takeAction, continueAfterOutcome,
    submitGuess, nextHand, continueTournament, finalizeTournament,
    resumeTournament, hasSavedGame, clearSavedGame,
    bb, sb, ante, bbDepth, day, nearBubble, scorePct,
  } = useGameState('full')

  const {
    phase, engine, streetResults, lastOption, lastChipDelta, lastDecision,
    heroStack, heroStackBefore, levelIndex, playersLeft, sessionScore, sessionMaxScore,
    guessOptions, guessCorrect, totalHands, heroSeatIndex,
  } = state

  useEffect(() => { startTournament('full') }, [])
  useEffect(() => { setCanResume(hasSavedGame()) }, [])
  useEffect(() => {
    if (phase === 'bust' || phase === 'win') {
      finalizeTournament(phase === 'win')
      clearSavedGame()
    }
  }, [phase])

  const decision = engine?.currentDecision ?? null
  const handNum  = totalHands + 1

  // ── Loading ──────────────────────────────────────────────
  if (phase === 'lobby') {
    return (
      <div className="h-screen flex items-center justify-center p-6" style={{ background: '#0d1117' }}>
        <div className="w-full max-w-sm space-y-4">
          <div className="text-center mb-8">
            <div className="text-[#d4a843] font-['Syne'] text-2xl font-bold mb-1">♠ WSOP Trainer</div>
            <div className="text-[#484f58] text-sm">Main Event Preparation</div>
          </div>

          {canResume && (
            <div className="rounded-xl border border-[#d4a843]/30 p-4"
              style={{ background: 'rgba(212,168,67,0.06)' }}>
              <div className="text-[#d4a843] text-sm font-bold font-['Syne'] mb-1">
                Saved Tournament Found
              </div>
              <div className="text-[#8b949e] text-[11px] mb-3">Continue where you left off</div>
              <button onClick={resumeTournament}
                className="w-full py-3 rounded-xl font-['Syne'] font-bold text-sm
                  text-[#0d0d0d] transition-colors hover:bg-[#e6b84a] mb-2"
                style={{ background: '#d4a843' }}>
                Resume Tournament →
              </button>
              <button onClick={() => { clearSavedGame(); startTournament(selectedMode) }}
                className="w-full py-2 rounded-xl font-['Syne'] text-sm text-[#484f58]
                  transition-colors hover:text-[#8b949e]"
                style={{ border: '1px solid #30363d' }}>
                Start New Tournament
              </button>
            </div>
          )}

          <div className="rounded-xl border border-[#30363d] p-3" style={{ background: '#161b22' }}>
            <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-2">
              Session Mode
            </div>
            <div className="grid grid-cols-2 gap-2">
              {([
                { mode: 'full', label: 'Full Tournament', desc: '282 hands, all 47 levels' },
                { mode: 'day1', label: 'Day 1',           desc: 'Levels 1–22, 198 hands' },
                { mode: 'day2', label: 'Day 2',           desc: 'Levels 23–39, 153 hands' },
                { mode: 'day3', label: 'Day 3+',          desc: 'Levels 40–47, 72 hands' },
              ] as const).map(({ mode, label, desc }) => (
                <button key={mode} onClick={() => setSelectedMode(mode)}
                  className="rounded-lg p-2.5 text-left transition-all"
                  style={{
                    background: selectedMode === mode ? 'rgba(212,168,67,0.15)' : 'rgba(255,255,255,0.03)',
                    border: selectedMode === mode ? '1px solid rgba(212,168,67,0.50)' : '1px solid #30363d',
                  }}>
                  <div className="font-['Syne'] font-bold text-[11px]"
                    style={{ color: selectedMode === mode ? '#d4a843' : '#8b949e' }}>
                    {label}
                  </div>
                  <div className="text-[9px] text-[#484f58] mt-0.5">{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {!canResume && (
            <button onClick={() => startTournament(selectedMode)}
              className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm
                text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
              style={{ background: '#d4a843' }}>
              Start Tournament →
            </button>
          )}
        </div>
      </div>
    )
  }

  if (!engine) {
    return (
      <div className="h-screen flex items-center justify-center" style={{ background: '#0d1117' }}>
        <div className="text-[#d4a843] font-['Syne'] text-xl font-bold animate-pulse">Dealing...</div>
      </div>
    )
  }

  // ── Shared header (mobile) ───────────────────────────────
  function MobileHeader() {
    return (
      <div className="px-3 py-2 flex-shrink-0 lg:hidden"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
        <div className="flex items-center justify-between mb-0.5">
          <span className="text-[#d4a843] text-xs font-bold font-['Syne']">♠ WSOP Main Event</span>
          <span className={`text-sm font-bold ${bbDepth < 15 ? 'text-[#f85149]' : bbDepth < 25 ? 'text-[#d4a843]' : 'text-[#e6edf3]'}`}>
            {fmtF(heroStack)} <span className="text-[#484f58] text-[10px]">{bbDepth}BB</span>
          </span>
        </div>
        <div className="flex items-center justify-between text-[10px] text-[#484f58]">
          <span>Day {day} · L{levelIndex + 1} · <span className="text-[#d4a843]">{fmtF(sb)}/{fmtF(bb)}</span> · {fmtF(ante)} ante</span>
          <span>Hand <span className="text-[#e6edf3]">{handNum}</span>/{TOTAL_HANDS}</span>
        </div>
        <div className="mt-1.5 w-full h-1 bg-[#30363d] rounded-full overflow-hidden">
          <div className="h-full bg-[#d4a843] rounded-full transition-all"
            style={{ width: `${Math.min(100, (totalHands / TOTAL_HANDS) * 100)}%` }} />
        </div>
      </div>
    )
  }

  function MobileStatusBar() {
    return (
      <div className="grid grid-cols-4 flex-shrink-0 lg:hidden"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
        {([
          { label: 'Stack',   value: fmt(heroStack),                              color: '#d4a843' },
          { label: 'Depth',   value: bbDepth + 'BB',                              color: bbDepth < 15 ? '#f85149' : bbDepth < 25 ? '#d4a843' : '#3fb950' },
          { label: 'Players', value: `${fmt(playersLeft)}/${fmt(TOTAL_PLAYERS)}`, color: playersLeft <= 2660 ? '#d4a843' : '#3fb950' },
          { label: 'Score',   value: sessionScore + 'pts',                        color: '#d4a843' },
        ] as { label: string; value: string; color: string }[]).map(({ label, value, color }) => (
          <div key={label} className="py-2 px-1 text-center border-r border-[#30363d] last:border-r-0">
            <div className="text-[9px] uppercase tracking-widest font-['Syne'] text-[#484f58]">{label}</div>
            <div className="text-[12px] font-bold" style={{ color }}>{value}</div>
          </div>
        ))}
      </div>
    )
  }

  // ── Terminal screens ─────────────────────────────────────
  if (phase === 'bust' || phase === 'win') {
    const isBust = phase === 'bust'
    return (
      <div className="h-screen flex flex-col max-w-lg mx-auto" style={{ background: '#0d1117' }}>
        <MobileHeader />
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="text-center py-8">
            <div className="text-5xl mb-3">{isBust ? '♠' : '🏆'}</div>
            <div className={`font-['Syne'] text-2xl font-bold mb-1 ${isBust ? 'text-[#f85149]' : 'text-[#d4a843]'}`}>
              {isBust ? 'Busted Out' : 'Champion!'}
            </div>
            {isBust && <div className="text-[#8b949e] text-sm">Day {day} · Level {levelIndex + 1} · {playersLeft.toLocaleString()} remained</div>}
          </div>
          <div className="rounded-xl border border-[#d4a843]/20 p-4" style={{ background: '#161b22' }}>
            <div className="text-[#d4a843] font-['Syne'] font-bold text-sm mb-3">Session Score</div>
            <div className="text-3xl font-bold font-['Syne'] text-[#d4a843] mb-1">{sessionScore}
              <span className="text-[#484f58] text-sm font-normal"> / {sessionMaxScore} pts</span>
            </div>
            <div className="w-full h-2 bg-[#30363d] rounded-full overflow-hidden">
              <div className="h-full rounded-full"
                style={{ width: `${scorePct}%`, background: scorePct >= 80 ? '#3fb950' : scorePct >= 60 ? '#d4a843' : '#f85149' }} />
            </div>
            <div className="text-[#484f58] text-[10px] mt-2">Hand {handNum} of {TOTAL_HANDS}</div>
          </div>
          <button onClick={() => startTournament('full')}
            className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
            style={{ background: '#d4a843' }}>
            New Tournament →
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'level_up' || phase === 'day_break') {
    const prevSb = levelIndex > 0 ? getSB(levelIndex - 1) : sb
    const prevBb = levelIndex > 0 ? getBB(levelIndex - 1) : bb
    const isNewDay = phase === 'day_break'

    return (
      <div className="h-screen flex flex-col" style={{ background: '#0d1117' }}>
        <div className="flex-1 overflow-y-auto p-4 space-y-3 max-w-lg mx-auto w-full">

          <div className="text-center pt-6 pb-2">
            <div className="text-[#d4a843] font-['Syne'] text-3xl font-bold mb-1">
              {isNewDay ? `Day ${day}` : `Level ${levelIndex + 1}`}
            </div>
            <div className="text-[#8b949e] text-sm">
              {isNewDay
                ? `Day ${day - 1} is over. Shuffle up and deal.`
                : 'New level begins'}
            </div>
          </div>

          <div className="rounded-xl border border-[#30363d] p-4" style={{ background: '#161b22' }}>
            <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-3">Stakes</div>
            <div className="flex items-center justify-between">
              <div className="text-center">
                <div className="text-[#484f58] text-[10px] mb-1">Was</div>
                <div className="text-[#8b949e] font-mono text-sm">{fmtF(prevSb)}/{fmtF(prevBb)}</div>
              </div>
              <div className="text-[#d4a843] text-xl">→</div>
              <div className="text-center">
                <div className="text-[#484f58] text-[10px] mb-1">Now</div>
                <div className="text-[#d4a843] font-mono text-sm font-bold">{fmtF(sb)}/{fmtF(bb)}</div>
              </div>
              <div className="text-center">
                <div className="text-[#484f58] text-[10px] mb-1">Ante</div>
                <div className="text-[#d4a843] font-mono text-sm font-bold">{fmtF(ante)}</div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-[#30363d] p-3" style={{ background: '#161b22' }}>
              <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-1">Your Stack</div>
              <div className="text-[#e6edf3] text-base font-bold font-['Syne']">{fmtF(heroStack)}</div>
              <div className="text-[#484f58] text-[10px]">{bbDepth}BB</div>
            </div>
            <div className="rounded-xl border border-[#30363d] p-3" style={{ background: '#161b22' }}>
              <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-1">Field</div>
              <div className="text-[#e6edf3] text-base font-bold font-['Syne']">{playersLeft.toLocaleString()}</div>
              <div className="text-[#484f58] text-[10px]">of {TOTAL_PLAYERS.toLocaleString()} remaining</div>
            </div>
          </div>

          <div className="rounded-xl border p-3 text-[11px] leading-relaxed"
            style={{
              background: bbDepth < 15 ? 'rgba(248,81,73,0.06)' :
                          bbDepth < 25 ? 'rgba(212,168,67,0.06)' :
                          'rgba(63,185,80,0.06)',
              borderColor: bbDepth < 15 ? 'rgba(248,81,73,0.20)' :
                           bbDepth < 25 ? 'rgba(212,168,67,0.20)' :
                           'rgba(63,185,80,0.20)',
              color: bbDepth < 15 ? '#f85149' :
                     bbDepth < 25 ? '#d4a843' :
                     '#3fb950',
            }}>
            {bbDepth < 15
              ? `⚠ You are in shove-or-fold territory at ${bbDepth}BB. No more open-raise-fold. Every raise should be for stacks.`
              : bbDepth < 25
              ? `⚡ At ${bbDepth}BB, 3-bets are near-commits. Pick your spots carefully and avoid calling off with marginal hands.`
              : bbDepth < 40
              ? `● At ${bbDepth}BB, standard tournament poker applies. Look for squeeze spots and protect your stack.`
              : `● At ${bbDepth}BB you have room to maneuver. Play position, build pots with strong hands, and apply pressure.`
            }
          </div>

          {nearBubble && (
            <div className="rounded-xl border border-[#d4a843]/20 p-3 text-[11px]"
              style={{ background: 'rgba(212,168,67,0.06)', color: '#d4a843' }}>
              ★ {(playersLeft - 2160).toLocaleString()} spots from the money.
              ICM pressure is HIGH. Tighten your shoving range and avoid
              marginal all-in confrontations.
            </div>
          )}
          {playersLeft <= 2160 && playersLeft > 500 && (
            <div className="rounded-xl border border-[#3fb950]/20 p-3 text-[11px]"
              style={{ background: 'rgba(63,185,80,0.06)', color: '#3fb950' }}>
              ★ You are in the money. Play for chip accumulation —
              ICM pressure eases as you go deeper.
            </div>
          )}
          {playersLeft <= 27 && (
            <div className="rounded-xl border border-[#f39c12]/20 p-3 text-[11px]"
              style={{ background: 'rgba(243,156,18,0.06)', color: '#f39c12' }}>
              Final table approaching. Every decision has massive ICM weight.
              Play premium hands, avoid coin flips.
            </div>
          )}

          <button onClick={continueTournament}
            className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
            style={{ background: '#d4a843' }}>
            {isNewDay ? `Start Day ${day} →` : `Start Level ${levelIndex + 1} →`}
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'itm') {
    return (
      <div className="h-screen flex flex-col max-w-lg mx-auto" style={{ background: '#0d1117' }}>
        <MobileHeader />
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="border border-[#d4a843]/25 rounded-xl p-5 text-center"
            style={{ background: 'rgba(212,168,67,0.06)' }}>
            <div className="text-[#d4a843] font-['Syne'] text-xl font-bold">★ In The Money!</div>
            <div className="text-[#8b949e] text-sm mt-1">{playersLeft.toLocaleString()} remain · {fmtF(heroStack)}</div>
          </div>
          <div className="text-[#484f58] text-xs text-center">ICM matters now. Tighten up in marginal spots.</div>
          <button onClick={continueTournament}
            className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
            style={{ background: '#d4a843' }}>
            Keep Playing →
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'recap') {
    const total = heroStack - heroStackBefore
    const heroCards = engine.heroSeat.holeCards
    return (
      <div className="h-screen flex flex-col max-w-lg mx-auto lg:max-w-2xl" style={{ background: '#0d1117' }}>
        <MobileHeader /><MobileStatusBar />
        <div className="flex-1 overflow-y-auto p-3 space-y-3">
          <div className="border border-[#d4a843]/20 rounded-xl p-3" style={{ background: '#161b22' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[#d4a843] font-['Syne'] font-bold">Hand #{handNum} Recap</div>
              {heroCards && (
                <div className="flex gap-1">
                  <Card r={heroCards[0].r} s={heroCards[0].s} size="sm" />
                  <Card r={heroCards[1].r} s={heroCards[1].s} size="sm" />
                </div>
              )}
            </div>
            {engine.board.length > 0 && (
              <div className="flex gap-1 mb-3">
                {engine.board.map((c, i) => <Card key={i} r={c.r} s={c.s} size="sm" />)}
              </div>
            )}
            {streetResults.length === 0 && (
              <div className="text-[#8b949e] text-[11px] leading-relaxed py-2">
                Everyone folded. BB wins the pot uncontested.
              </div>
            )}
            {streetResults.map((r, i) => (
              <div key={i} className="py-3"
                style={{ borderBottom: i < streetResults.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none' }}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[#d4a843] text-[10px] font-bold uppercase tracking-widest font-['Syne']">{r.street}</span>
                  {r.board.length > 0 && (
                    <div className="flex gap-0.5">
                      {r.board.map((c, j) => <Card key={j} r={c.r} s={c.s} size="xs" />)}
                    </div>
                  )}
                </div>
                {r.preDesc && (
                  <div className="text-[#8b949e] text-[11px] leading-relaxed mb-2">{r.preDesc}</div>
                )}
                <div className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 mb-2"
                  style={{ background: Q_BG[r.heroAction.quality], border: `1px solid ${Q_BORDER[r.heroAction.quality]}` }}>
                  <span className="text-[#e6edf3] text-[11px] font-semibold">You: {r.heroAction.label}</span>
                  <QBadge q={r.heroAction.quality} small />
                  <span className={`text-[11px] font-bold ml-auto ${r.chipDelta < 0 ? 'text-[#f85149]' : r.chipDelta > 0 ? 'text-[#3fb950]' : 'text-[#484f58]'}`}>
                    {r.chipDelta > 0 ? '+' : ''}{fmtF(r.chipDelta)}
                  </span>
                </div>
                {r.postDesc && (
                  <div className="text-[#8b949e] text-[11px] leading-relaxed mb-1.5">{r.postDesc}</div>
                )}
                <div className="text-[#484f58] text-[10px] italic leading-snug">{r.heroAction.coaching}</div>
              </div>
            ))}
            <div className="flex justify-between mt-3 pt-3 border-t border-[#30363d]">
              <span className="text-[#8b949e] text-xs">Net this hand</span>
              <span className={`font-bold font-['Syne'] ${total > 0 ? 'text-[#3fb950]' : total < 0 ? 'text-[#f85149]' : 'text-[#484f58]'}`}>
                {total > 0 ? '+' : ''}{fmtF(total)}
              </span>
            </div>
          </div>
          <button onClick={nextHand}
            className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
            style={{ background: '#d4a843' }}>
            Next Hand →
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'villain_guess') {
    const ACTION_LABELS: Record<string, string> = {
      fold: 'Fold', limp: 'Limp', call: 'Call', rfi: 'Raised',
      '3bet': '3-Bet', '4bet': '4-Bet', shove: 'Shoved',
      b: 'Bet', x: 'Check', c: 'Call', r: 'Raise', f: 'Fold',
      xc: 'Check-Call', xr: 'Check-Raise', xf: 'Check-Fold',
    }
    const STREET_LABELS = ['Preflop', 'Flop', 'Turn', 'River']

    function handToCards(handStr: string): { r: string; s: string }[] {
      if (handStr.length < 2) return []
      const suits = ['s', 'h', 'd', 'c']
      if (handStr.length === 2) {
        return [{ r: handStr[0], s: 's' }, { r: handStr[1], s: 'h' }]
      }
      const r1 = handStr[0]
      const r2 = handStr[1]
      const suited = handStr.endsWith('s')
      const s1 = suits[Math.floor(Math.random() * 4)]
      if (suited) {
        return [{ r: r1, s: s1 }, { r: r2, s: s1 }]
      }
      const s2 = suits.find(s => s !== s1) ?? 'h'
      return [{ r: r1, s: s1 }, { r: r2, s: s2 }]
    }

    return (
      <div className="h-screen flex flex-col max-w-lg mx-auto" style={{ background: '#0d1117' }}>
        <MobileHeader /><MobileStatusBar />
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="border border-[#1f6feb]/25 rounded-xl p-4" style={{ background: '#161b22' }}>
            <div className="text-[#1f6feb] font-['Syne'] font-bold mb-1">What&apos;s their hand?</div>
            {engine.board.length > 0 && (
              <div className="flex gap-1 mb-3">
                {engine.board.map((c, i) => <Card key={i} r={c.r} s={c.s} size="sm" />)}
              </div>
            )}
            {engine.primaryVillain && engine.primaryVillain.actionSequence.length > 0 && (
              <div className="mb-4 p-3 rounded-xl border border-[#30363d]"
                style={{ background: '#0d1117' }}>
                <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-2">Their Line</div>
                <div className="flex gap-3 flex-wrap mb-1.5">
                  {engine.primaryVillain.actionSequence.map((action, i) => (
                    <div key={i} className="flex flex-col items-center">
                      <div className="text-[#484f58] text-[8px]">{STREET_LABELS[i] ?? ''}</div>
                      <div className="text-[#d4a843] text-[11px] font-bold font-mono">
                        {ACTION_LABELS[action] ?? action}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="text-[#484f58] text-[9px] italic leading-tight">
                  {engine.primaryVillain.rangeNarrow}
                </div>
              </div>
            )}
            <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] mb-2">
              Put them on a hand
            </div>
            <div className="grid grid-cols-2 gap-2">
              {guessOptions.map((opt, i) => {
                const cards = handToCards(opt)
                return (
                  <button key={i} onClick={() => submitGuess(opt)}
                    className="flex items-center justify-center gap-2 py-3 px-2 rounded-xl active:scale-[0.97] transition-transform"
                    style={{ border: '1px solid rgba(31,111,235,0.30)', background: 'rgba(31,111,235,0.08)' }}>
                    {cards.map((c, j) => <Card key={j} r={c.r} s={c.s} size="sm" />)}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (phase === 'villain_reveal') {
    const villain = engine.showdownSeat
    const heroCards = engine.heroSeat.holeCards
    return (
      <div className="h-screen flex flex-col max-w-lg mx-auto" style={{ background: '#0d1117' }}>
        <MobileHeader /><MobileStatusBar />
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="border border-[#d4a843]/20 rounded-xl p-4 text-center" style={{ background: '#161b22' }}>
            <div className={`font-['Syne'] font-bold text-xl mb-4 ${engine.heroWon ? 'text-[#3fb950]' : 'text-[#f85149]'}`}>
              {engine.heroWon ? '✓ You win!' : '✗ Villain wins'}
            </div>
            <div className="flex justify-center gap-8 mb-4">
              {heroCards && (
                <div className="text-center">
                  <div className="text-[#484f58] text-[9px] mb-1 font-['Syne']">YOU</div>
                  <div className="flex gap-1 justify-center">
                    <Card r={heroCards[0].r} s={heroCards[0].s} size="md" />
                    <Card r={heroCards[1].r} s={heroCards[1].s} size="md" />
                  </div>
                </div>
              )}
              {villain?.holeCards && (
                <div className="text-center">
                  <div className="text-[#484f58] text-[9px] mb-1 font-['Syne']">{villain.position}</div>
                  <div className="flex gap-1 justify-center">
                    <Card r={villain.holeCards[0].r} s={villain.holeCards[0].s} size="md" />
                    <Card r={villain.holeCards[1].r} s={villain.holeCards[1].s} size="md" />
                  </div>
                </div>
              )}
            </div>
            {engine.board.length > 0 && (
              <div className="flex justify-center gap-1 mb-4">
                {engine.board.map((c, i) => <Card key={i} r={c.r} s={c.s} size="sm" />)}
              </div>
            )}
            <div className={`font-bold font-['Syne'] text-lg ${engine.heroWon ? 'text-[#3fb950]' : 'text-[#f85149]'}`}>
              {engine.heroWon
                ? `+${fmtF(engine.pot - engine.heroSeat.invested)}`
                : engine.isTie
                ? `Chopped — ±0`
                : `-${fmtF(engine.heroSeat.invested)}`} chips
            </div>
          </div>
          <button onClick={nextHand}
            className="w-full py-3.5 rounded-xl font-['Syne'] font-bold text-sm text-[#0d0d0d] transition-colors hover:bg-[#e6b84a]"
            style={{ background: '#d4a843' }}>
            See Recap →
          </button>
        </div>
      </div>
    )
  }

  // ── Playing / Outcome ─────────────────────────────────────
  return (
    <div className="h-screen flex flex-col overflow-hidden" style={{ background: '#0d1117' }}>

      {/* Desktop header */}
      <div className="hidden lg:flex items-center justify-between px-6 py-2.5 flex-shrink-0"
        style={{ background: '#161b22', borderBottom: '1px solid #30363d' }}>
        <div className="flex items-center gap-4">
          <span className="text-[#d4a843] font-['Syne'] font-bold text-sm">♠ WSOP Main Event</span>
          <span className="text-[#484f58] text-xs">
            Day {day} · Level {levelIndex + 1} · <span className="text-[#d4a843]">{fmtF(sb)}/{fmtF(bb)}</span> · {fmtF(ante)} ante
          </span>
        </div>
        <div className="flex items-center gap-6">
          <span className="text-xs text-[#484f58]">Hand <span className="text-[#e6edf3]">{handNum}</span>/{TOTAL_HANDS}</span>
          <div className="w-32 h-1.5 bg-[#30363d] rounded-full overflow-hidden">
            <div className="h-full bg-[#d4a843] rounded-full transition-all"
              style={{ width: `${Math.min(100, (totalHands / TOTAL_HANDS) * 100)}%` }} />
          </div>
          <span className={`font-bold text-sm ${bbDepth < 15 ? 'text-[#f85149]' : bbDepth < 25 ? 'text-[#d4a843]' : 'text-[#e6edf3]'}`}>
            {fmtF(heroStack)} <span className="text-[#484f58] text-xs">{bbDepth}BB</span>
          </span>
        </div>
      </div>

      {/* Mobile header */}
      <MobileHeader />
      <MobileStatusBar />

      {/* Desktop 3-column */}
      <div className="hidden lg:flex flex-1 overflow-hidden">

        {/* Left panel */}
        <div className="w-[280px] flex-shrink-0 p-4 overflow-y-auto" style={{ borderRight: '1px solid #30363d' }}>
          <LeftPanel state={state} bb={bb} sb={sb} ante={ante} day={day}
            bbDepth={bbDepth} nearBubble={nearBubble} />
        </div>

        {/* Center: table */}
        <div className="flex-1 flex flex-col justify-center items-center p-6 min-h-0">
          <div className="w-full max-w-xl">
            <TableVisual engine={engine} heroSeatIndex={heroSeatIndex} compact={false} />
          </div>
          {(decision || lastDecision) && (
            <div className="w-full max-w-xl mt-3 rounded-xl border-l-2 border-[#d4a843] px-4 py-2.5"
              style={{ background: '#161b22' }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[#d4a843] text-[10px] font-bold uppercase tracking-widest font-['Syne']">
                  {(phase === 'outcome' ? lastDecision?.street : decision?.street)?.toUpperCase()}
                </span>
                <span className="text-[#e6edf3] text-[11px] font-bold font-['Syne']">
                  Pot: {fmtF(phase === 'outcome' ? (lastDecision?.pot ?? decision?.pot ?? 0) : (decision?.pot ?? 0))}
                </span>
              </div>
              <div className="text-[#8b949e] text-[12px] leading-relaxed">
                {phase === 'outcome' ? lastDecision?.desc : decision?.desc}
              </div>
            </div>
          )}
          {phase === 'playing' && decision && (
            <div className="w-full max-w-xl mt-2">
              <HandMeter heroCards={decision.heroCards} board={decision.board} heroPos={decision.heroPos} bb={bb} heroStack={heroStack} />
            </div>
          )}
          {phase === 'outcome' && lastDecision && (
            <div className="w-full max-w-xl mt-2">
              <HandMeter heroCards={lastDecision.heroCards} board={lastDecision.board} heroPos={lastDecision.heroPos} bb={bb} heroStack={heroStack} />
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="w-[320px] flex-shrink-0 p-4 overflow-y-auto" style={{ borderLeft: '1px solid #30363d' }}>
          {phase === 'playing' && decision && (
            <RightPanelPlaying decision={decision} takeAction={takeAction} pot={decision.pot} />
          )}
          {phase === 'outcome' && (
            <RightPanelOutcome
              lastOption={lastOption} lastDecision={lastDecision}
              lastChipDelta={lastChipDelta} engine={engine}
              continueAfterOutcome={continueAfterOutcome}
              pendingStreetDesc={engine?.pendingStreetDesc ?? ''} />
          )}
        </div>
      </div>

      {/* Mobile stacked */}
      <div className="flex-1 overflow-y-auto lg:hidden">
        <div className="px-2 pt-2">
          <TableVisual engine={engine} heroSeatIndex={heroSeatIndex} compact={true} />
        </div>

        <div className="p-3 space-y-3">
          {/* Street history pills */}
          {streetResults.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {streetResults.map((r, i) => (
                <div key={i} className="flex items-center gap-1 rounded-full px-2 py-0.5"
                  style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                  <span className="text-[#d4a843] text-[9px] font-bold uppercase font-['Syne']">{r.street}</span>
                  <span className="text-[#8b949e] text-[9px]">{r.heroAction.label}</span>
                  <span className={`text-[9px] font-bold ${r.chipDelta < 0 ? 'text-[#f85149]' : r.chipDelta > 0 ? 'text-[#3fb950]' : 'text-[#484f58]'}`}>
                    {r.chipDelta > 0 ? '+' : ''}{fmtF(r.chipDelta)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Situation card (playing) */}
          {decision && phase === 'playing' && (
            <div className="rounded-xl border-l-[3px] border-[#d4a843] p-3" style={{ background: '#161b22' }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[#d4a843] text-[9px] uppercase tracking-widest font-['Syne'] font-bold">
                  {decision.street.toUpperCase()}
                </span>
                <span className="text-[#e6edf3] text-[10px] font-bold font-['Syne']">
                  Pot: {fmtF(decision.pot)}
                </span>
              </div>
              <div className="text-[#8b949e] text-[11px] leading-relaxed">{decision.desc}</div>
              {engine.primaryVillain && engine.primaryVillain.rangeStrength > 0 && (
                <div className="mt-1.5 text-[9px] leading-snug" style={{ color:
                  engine.primaryVillain.rangeStrength >= 8 ? '#f85149' :
                  engine.primaryVillain.rangeStrength >= 6 ? '#d4a843' :
                  engine.primaryVillain.rangeStrength >= 4 ? '#3fb950' :
                  '#484f58'
                }}>
                  Villain: {engine.primaryVillain.rangeNarrow}
                </div>
              )}
            </div>
          )}
          {phase === 'playing' && decision && (
            <HandMeter heroCards={decision.heroCards} board={decision.board} heroPos={decision.heroPos} bb={bb} heroStack={heroStack} />
          )}

          {/* Situation card (outcome) */}
          {lastDecision && phase === 'outcome' && (
            <div className="rounded-xl border-l-[3px] border-[#d4a843] p-3" style={{ background: '#161b22' }}>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[#d4a843] text-[9px] uppercase tracking-widest font-['Syne'] font-bold">
                  {lastDecision.street.toUpperCase()}
                </span>
                <span className="text-[#e6edf3] text-[10px] font-bold font-['Syne']">
                  Pot: {fmtF(lastDecision.pot)}
                </span>
              </div>
              <div className="text-[#8b949e] text-[11px] leading-relaxed">{lastDecision.desc}</div>
            </div>
          )}
          {phase === 'outcome' && lastDecision && (
            <HandMeter heroCards={lastDecision.heroCards} board={lastDecision.board} heroPos={lastDecision.heroPos} bb={bb} heroStack={heroStack} />
          )}

          {nearBubble && (
            <div className="rounded-xl px-3 py-1.5 text-[#d4a843] text-[10px]"
              style={{ background: 'rgba(212,168,67,0.07)', border: '1px solid rgba(212,168,67,0.18)' }}>
              ★ {(playersLeft - 2160).toLocaleString()} spots from the money. ICM pressure HIGH.
            </div>
          )}
          {bbDepth < 15 && (
            <div className="rounded-xl px-3 py-1.5 text-[#f85149] text-[10px]"
              style={{ background: 'rgba(248,81,73,0.08)', border: '1px solid rgba(248,81,73,0.20)' }}>
              ⚠ {bbDepth}BB — Shove or fold only.
            </div>
          )}

          {/* Playing */}
          {phase === 'playing' && decision && (
            <div className="space-y-2">
              <div className="text-[#484f58] text-[9px] uppercase tracking-widest font-['Syne'] font-bold">Your Action</div>
              {decision.options.map((opt, i) => (
                <ActionBtn key={i} opt={opt} pot={decision.pot} onClick={() => takeAction(i)} />
              ))}
            </div>
          )}

          {/* Outcome */}
          {phase === 'outcome' && lastOption && (
            <RightPanelOutcome
              lastOption={lastOption} lastDecision={lastDecision}
              lastChipDelta={lastChipDelta} engine={engine}
              continueAfterOutcome={continueAfterOutcome}
              pendingStreetDesc={engine?.pendingStreetDesc ?? ''} />
          )}
        </div>
      </div>
    </div>
  )
}
