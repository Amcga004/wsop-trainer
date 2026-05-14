import { supabase } from './supabase'
import type { SessionMode } from '../types'

export async function createTournament(mode: SessionMode): Promise<string | null> {
  console.log('Supabase URL:', process.env.NEXT_PUBLIC_SUPABASE_URL?.slice(0, 30))
  console.log('Attempting tournament insert with mode:', mode)

  const { data, error } = await supabase
    .from('tournaments')
    .insert({ mode })
    .select('id')
    .single()

  if (error) {
    console.error('Error name:', error.name)
    console.error('Error message:', error.message)
    console.error('Error code:', error.code)
    console.error('Error hint:', error.hint)
    console.error('Error details:', error.details)
    console.error('Full error keys:', Object.keys(error))
    console.error('Error JSON:', JSON.stringify(error, null, 2))
    console.error('Error toString:', error.toString())
    // Try accessing as unknown object
    const e = error as any
    console.error('status:', e.status)
    console.error('statusCode:', e.statusCode)
    console.error('body:', e.body)
    return null
  }

  console.log('Tournament created successfully:', data.id)
  return data.id
}

export async function endTournament(
  id: string,
  finalStack: number,
  levelsCompleted: number,
  totalScore: number,
  maxScore: number,
  decisionsCount: number,
  cashed: boolean,
  bustedDay?: number,
  bustedLevel?: number,
  finishPosition?: number,
): Promise<void> {
  try {
    await supabase.from('tournaments').update({
      ended_at:         new Date().toISOString(),
      final_stack:      finalStack,
      levels_completed: levelsCompleted,
      total_score:      totalScore,
      max_score:        maxScore,
      decisions_count:  decisionsCount,
      cashed,
      busted_day:       bustedDay,
      busted_level:     bustedLevel,
      finish_position:  finishPosition,
    }).eq('id', id)
  } catch (err) {
    console.error('endTournament failed:', err)
  }
}
