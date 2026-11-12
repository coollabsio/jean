import { describe, expect, it } from 'vitest'
import { continueListOnNewline } from './list-continuation'

describe('continueListOnNewline', () => {
  it('continues a numbered list with the next number', () => {
    const text = '1. Fix the queue drain'
    expect(continueListOnNewline(text, text.length)).toEqual({
      text: '1. Fix the queue drain\n2. ',
      caret: '1. Fix the queue drain\n2. '.length,
    })
  })

  it('keeps the delimiter and indentation of the current item', () => {
    const text = '  9) nested item'
    expect(continueListOnNewline(text, text.length)?.text).toBe(
      '  9) nested item\n  10) '
    )
  })

  it('continues bulleted lists with the same bullet', () => {
    expect(continueListOnNewline('- first', '- first'.length)?.text).toBe(
      '- first\n- '
    )
    expect(continueListOnNewline('\t* nested', '\t* nested'.length)?.text).toBe(
      '\t* nested\n\t* '
    )
  })

  it('continues the list item the caret is in, not the last line', () => {
    const text = '1. one\n2. two\n3. three'
    const caret = '1. one\n2. tw'.length
    expect(continueListOnNewline(text, caret)?.text).toBe(
      '1. one\n2. tw\n3. o\n3. three'
    )
  })

  it('ends the list when the current item is empty', () => {
    const text = '1. done\n2. '
    expect(continueListOnNewline(text, text.length)).toEqual({
      text: '1. done\n',
      caret: '1. done\n'.length,
    })
  })

  it('leaves non-list lines to the default newline', () => {
    expect(continueListOnNewline('plain text', 'plain text'.length)).toBeNull()
    expect(continueListOnNewline('1.5 is not a list', 16)).toBeNull()
    expect(continueListOnNewline('', 0)).toBeNull()
  })

  it('ignores a caret outside the text', () => {
    expect(continueListOnNewline('1. one', -1)).toBeNull()
    expect(continueListOnNewline('1. one', 99)).toBeNull()
  })
})
