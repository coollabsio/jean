import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeCategory,
  groupWorktreesByCategory,
  WORKTREE_CATEGORY_ORDER,
} from './worktree-category'

const NOW = 1_800_000_000

function signals(
  overrides: Partial<Parameters<typeof classifyWorktreeCategory>[0]> = {}
): Parameters<typeof classifyWorktreeCategory>[0] {
  return {
    isBase: false,
    worktreeStatus: 'ready',
    standbyReason: undefined,
    standbyUntil: undefined,
    hasHumanAttention: false,
    hasAiActivity: false,
    hasPullRequest: false,
    ciOverallStatus: undefined,
    previewStatus: undefined,
    now: NOW,
    ...overrides,
  }
}

describe('classifyWorktreeCategory', () => {
  it('donne la priorité au standby sur une décision humaine en attente', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasHumanAttention: true,
          hasAiActivity: true,
          standbyReason: 'Validation produit',
          standbyUntil: NOW + 3600,
        })
      )
    ).toBe('standby')
  })

  it('donne la priorité au standby sur une IA active', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasAiActivity: true,
          standbyReason: 'Retour métier',
          standbyUntil: NOW + 3600,
        })
      )
    ).toBe('standby')
  })

  it('donne la priorité au standby sur une CI en cours', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          standbyReason: 'Retour métier',
          standbyUntil: NOW + 3600,
          hasPullRequest: true,
          ciOverallStatus: 'BUILDING',
          previewStatus: 'STALE',
        })
      )
    ).toBe('standby')
  })

  it('respecte un standby métier actif et réveille un standby expiré', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          standbyReason: 'Retour métier',
          standbyUntil: NOW + 3600,
        })
      )
    ).toBe('standby')

    expect(
      classifyWorktreeCategory(
        signals({
          standbyReason: 'Retour métier',
          standbyUntil: NOW,
        })
      )
    ).toBe('needs_brain')
  })

  it.each([
    ['BUILDING', undefined],
    ['QUEUED', undefined],
    ['SUCCESS', 'STALE'],
  ])('laisse Jean surveiller la CI %s / preview %s', (ci, preview) => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasPullRequest: true,
          ciOverallStatus: ci,
          previewStatus: preview,
        })
      )
    ).toBe('monitoring')
  })

  it('laisse Jean surveiller une CI active même si une ancienne revue attend encore', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasHumanAttention: true,
          hasPullRequest: true,
          ciOverallStatus: 'BUILDING',
          previewStatus: 'STALE',
        })
      )
    ).toBe('monitoring')
  })

  it.each([
    ['FAILURE', undefined],
    ['SUCCESS', 'DOWN'],
  ])('remonte la CI %s / preview %s comme action humaine', (ci, preview) => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasPullRequest: true,
          ciOverallStatus: ci,
          previewStatus: preview,
        })
      )
    ).toBe('needs_brain')
  })

  it('garde au calme une PR verte et une session de base inactive', () => {
    expect(
      classifyWorktreeCategory(
        signals({
          hasPullRequest: true,
          ciOverallStatus: 'SUCCESS',
          previewStatus: 'UP_TO_DATE',
        })
      )
    ).toBe('calm')
    expect(classifyWorktreeCategory(signals({ isBase: true }))).toBe('calm')
  })

  it('surveille une création et une PR dont le statut est encore inconnu', () => {
    expect(
      classifyWorktreeCategory(signals({ worktreeStatus: 'pending' }))
    ).toBe('monitoring')
    expect(classifyWorktreeCategory(signals({ hasPullRequest: true }))).toBe(
      'monitoring'
    )
  })
})

describe('groupWorktreesByCategory', () => {
  it('retourne les catégories dans l’ordre cognitif sans modifier l’ordre interne', () => {
    const groups = groupWorktreesByCategory([
      { item: 'calm', category: 'calm' },
      { item: 'brain-a', category: 'needs_brain' },
      { item: 'ai', category: 'ai_running' },
      { item: 'brain-b', category: 'needs_brain' },
    ])

    expect(groups.map(group => group.category)).toEqual(WORKTREE_CATEGORY_ORDER)
    expect(groups[0]?.items).toEqual(['brain-a', 'brain-b'])
    expect(groups[1]?.items).toEqual(['ai'])
    expect(groups[4]?.items).toEqual(['calm'])
  })
})
