import { supabase } from './supabase'

export interface SaveDecisionParams {
  tournamentId?:  string | null
  handNumber?:    number
  street:         string
  heroPos:        string
  heroCards?:     Array<{ r: string; s: string }>
  board?:         Array<{ r: string; s: string }>
  action:         string
  quality:        string
  pot?:           number
  chipCost?:      number
  levelIndex?:    number
  playersLeft?:   number
  // Legacy DecisionRecord fields
  scenarioType?:  string
  points?:        number
  stackBefore?:   number
  stackAfter?:    number
  chipDelta?:     number
  coaching?:      string
}

export async function saveDecision(params: SaveDecisionParams): Promise<void> {
  if (!params.tournamentId) return
  try {
    await supabase.from('decisions').insert({
      tournament_id:  params.tournamentId,
      hand_number:    params.handNumber,
      level_index:    params.levelIndex,
      scenario_type:  params.scenarioType,
      street:         params.street,
      hero_pos:       params.heroPos,
      action_taken:   params.action,
      quality:        params.quality,
      points_earned:  params.points,
      stack_before:   params.stackBefore,
      stack_after:    params.stackAfter,
      chip_delta:     params.chipDelta,
      coaching_note:  params.coaching,
      pot:            params.pot,
      chip_cost:      params.chipCost,
      players_left:   params.playersLeft,
    })
  } catch (err) {
    // silently ignore
  }
}
