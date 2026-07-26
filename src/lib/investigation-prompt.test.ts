import { describe, expect, it } from 'vitest'
import {
  applyYoloInvestigationFixDirective,
  stripInvestigationAntiFixLines,
  YOLO_INVESTIGATION_FIX_APPEND,
  YOLO_INVESTIGATION_FIX_MARKER,
} from './investigation-prompt'

describe('applyYoloInvestigationFixDirective', () => {
  it('leaves non-yolo prompts unchanged', () => {
    const prompt = 'Investigate the issue\nPropose a solution'
    expect(applyYoloInvestigationFixDirective(prompt, 'plan')).toBe(prompt)
    expect(applyYoloInvestigationFixDirective(prompt, 'build')).toBe(prompt)
    expect(applyYoloInvestigationFixDirective(prompt, null)).toBe(prompt)
    expect(applyYoloInvestigationFixDirective(prompt, undefined)).toBe(prompt)
  })

  it('appends an unconditional fix directive in yolo mode', () => {
    const prompt = 'Investigate the loaded GitHub issue (#42)\n\nPropose solution'
    const result = applyYoloInvestigationFixDirective(prompt, 'yolo')
    expect(result).toContain(YOLO_INVESTIGATION_FIX_MARKER)
    expect(result).toContain('After investigation, fix the issue')
    expect(result).toContain(prompt)
    expect(result.endsWith('\n')).toBe(true)
  })

  it('strips weak conditional yolo lines before appending', () => {
    const prompt = `Investigate issue #1
6. Propose solution
7. If you are in yolo mode, also apply the fix(es) — implement the changes
- If you are in yolo mode, also apply the fix(es) after investigation`

    const result = applyYoloInvestigationFixDirective(prompt, 'yolo')
    expect(result).not.toMatch(/If you are in yolo mode/i)
    expect(result).toContain(YOLO_INVESTIGATION_FIX_MARKER)
    expect(result).toContain('Propose solution')
  })

  it('strips anti-fix restrictions that block implementation', () => {
    const prompt = `Investigate the bug
Do not implement fixes.
Only investigate and propose a plan.
Propose solution with files to change.`

    const result = applyYoloInvestigationFixDirective(prompt, 'yolo')
    const body = result.split(YOLO_INVESTIGATION_FIX_MARKER)[0]
    expect(body).not.toMatch(/Do not implement fixes/i)
    expect(body).not.toMatch(/Only investigate/i)
    expect(body).toContain('Propose solution with files to change')
    expect(result).toContain(YOLO_INVESTIGATION_FIX_MARKER)
  })

  it('is idempotent when the marker is already present', () => {
    const once = applyYoloInvestigationFixDirective('Investigate #1', 'yolo')
    const twice = applyYoloInvestigationFixDirective(once, 'yolo')
    expect(twice).toBe(once)
    expect(twice.split(YOLO_INVESTIGATION_FIX_MARKER).length - 1).toBe(1)
  })

  it('exposes the full append text for tests and docs', () => {
    expect(YOLO_INVESTIGATION_FIX_APPEND).toContain(YOLO_INVESTIGATION_FIX_MARKER)
    expect(YOLO_INVESTIGATION_FIX_APPEND).toContain(
      'Any earlier instruction to only investigate'
    )
  })
})

describe('stripInvestigationAntiFixLines', () => {
  it('keeps unrelated do-not lines', () => {
    const prompt =
      'Do not invent pull request numbers.\nReference file paths.\nDo not implement yet.'
    const result = stripInvestigationAntiFixLines(prompt)
    expect(result).toContain('Do not invent pull request numbers')
    expect(result).toContain('Reference file paths')
    expect(result).not.toContain('Do not implement yet')
  })
})
