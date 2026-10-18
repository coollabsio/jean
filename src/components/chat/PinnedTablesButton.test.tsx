import { describe, expect, it } from 'vitest'
import { pinnedTableTitle } from './PinnedTablesButton'

describe('pinnedTableTitle', () => {
  it('joins the header cells without markdown marks', () => {
    expect(
      pinnedTableTitle('| **Issue** | `State` | a \\| b |\n| --- | --- | --- |')
    ).toBe('Issue · State · a \\| b')
  })

  it('falls back to "Table" when there is no header text', () => {
    expect(pinnedTableTitle('')).toBe('Table')
  })
})
