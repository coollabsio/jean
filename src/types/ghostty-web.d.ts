declare module 'ghostty-web' {
  import type { ITerminalOptions } from '@xterm/xterm'

  export function init(): Promise<void>

  export class Terminal {
    constructor(options?: ITerminalOptions)

    cols: number
    rows: number
    options: ITerminalOptions
    renderer?: { renderScrollbar?: (...args: unknown[]) => void }

    attachCustomKeyEventHandler(
      customKeyEventHandler: (event: KeyboardEvent) => boolean
    ): void
    clear(): void
    clearSelection(): void
    dispose(): void
    focus(): void
    getSelection(): string
    hasSelection(): boolean
    loadAddon(addon: { activate?: (terminal: Terminal) => void }): void
    onData(callback: (data: string) => void): void
    open(parent: HTMLElement): void
    refresh(start: number, end: number): void
    write(data: string): void
    writeln(data: string): void
  }

  export class FitAddon {
    activate(terminal: Terminal): void
    dispose?(): void
    fit(): void
  }
}
