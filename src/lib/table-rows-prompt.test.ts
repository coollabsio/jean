import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  invokeForServer: vi.fn(),
}))

import { useChatStore } from '@/store/chat-store'
import {
  formatTableRowsPrompt,
  tableToMarkdown,
  setTableRowInPrompt,
} from './table-rows-prompt'

const DATA = [
  ['Issue', 'State'],
  ['#1', 'Open'],
  ['#2', 'Closed'],
  ['#3', 'a | b'],
]

function chip() {
  return useChatStore.getState().pendingTextFiles['s1']?.[0]
}

describe('table rows prompt', () => {
  beforeEach(() => {
    useChatStore.setState({ pendingTextFiles: {} })
    mockInvoke.mockReset()
    mockInvoke.mockImplementation(async (cmd: string, args: unknown) => {
      if (cmd === 'save_pasted_text') {
        return {
          id: 'tf-1',
          path: '/p/tf-1.txt',
          filename: 'tf-1.txt',
          size: 1,
        }
      }
      if (cmd === 'update_pasted_text') {
        return (args as { content: string }).content.length
      }
      return undefined
    })
  })

  it('formats the header plus picked rows and escapes pipes', () => {
    expect(tableToMarkdown([['a|b'], ['x\ny']])).toBe(
      '| a\\|b |\n| --- |\n| x y |'
    )
    expect(formatTableRowsPrompt(DATA, [2, 0])).toContain(
      '| Issue | State |\n| --- | --- |\n| #3 | a \\| b |\n| #1 | Open |'
    )
  })

  it('creates one chip, adds rows in table order, and deletes it when empty', async () => {
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, '')
    // sessionId routes the file to the session's Jean server (remote servers)
    expect(mockInvoke).toHaveBeenCalledWith('save_pasted_text', {
      content: formatTableRowsPrompt(DATA, [1]),
      filename: 'table-rows',
      sessionId: 's1',
    })
    expect(chip()?.tableRows).toEqual({
      tableKey: 'm:0',
      rows: [1],
      notes: {},
    })
    expect(chip()?.content).toContain('| #2 | Closed |')

    await setTableRowInPrompt('s1', 'm:0', 0, DATA, '')
    expect(useChatStore.getState().pendingTextFiles['s1']).toHaveLength(1)
    expect(chip()?.tableRows?.rows).toEqual([0, 1])
    expect(mockInvoke).toHaveBeenCalledWith('update_pasted_text', {
      path: '/p/tf-1.txt',
      content: formatTableRowsPrompt(DATA, [0, 1]),
      sessionId: 's1',
    })

    await setTableRowInPrompt('s1', 'm:0', 0, DATA, null)
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, null)
    expect(useChatStore.getState().pendingTextFiles['s1']).toEqual([])
    expect(mockInvoke).toHaveBeenCalledWith('delete_pasted_text', {
      path: '/p/tf-1.txt',
      sessionId: 's1',
    })
  })

  it('adds a Note column for rows with a note, and keeps notes on update', async () => {
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, '  fix first ')
    expect(chip()?.content).toContain(
      '| Issue | State | Note |\n| --- | --- | --- |\n| #2 | Closed | fix first |'
    )
    await setTableRowInPrompt('s1', 'm:0', 0, DATA, '')
    expect(chip()?.content).toContain(
      '| #1 | Open |  |\n| #2 | Closed | fix first |'
    )

    // Editing the note keeps the row once, with the new text
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, 'later')
    expect(chip()?.tableRows?.rows).toEqual([0, 1])
    expect(chip()?.tableRows?.notes).toEqual({ 1: 'later' })

    // Removing the noted row drops the Note column
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, null)
    expect(chip()?.content).toContain(
      '| Issue | State |\n| --- | --- |\n| #1 | Open |'
    )
  })

  it('does not create a chip when removing a row that is not in the prompt', async () => {
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, null)
    expect(useChatStore.getState().pendingTextFiles['s1'] ?? []).toEqual([])
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('does not create two chips on fast clicks', async () => {
    await Promise.all([
      setTableRowInPrompt('s1', 'm:0', 0, DATA, ''),
      setTableRowInPrompt('s1', 'm:0', 2, DATA, ''),
    ])
    expect(useChatStore.getState().pendingTextFiles['s1']).toHaveLength(1)
    expect(chip()?.tableRows?.rows).toEqual([0, 2])
  })

  it('starts a new chip after the old one was removed from the input', async () => {
    await setTableRowInPrompt('s1', 'm:0', 0, DATA, '')
    useChatStore.getState().removePendingTextFile('s1', 'tf-1')
    await setTableRowInPrompt('s1', 'm:0', 1, DATA, '')
    expect(chip()?.tableRows?.rows).toEqual([1])
  })
})
