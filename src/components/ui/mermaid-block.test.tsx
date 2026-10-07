import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { MermaidBlock } from './mermaid-block'

const { renderDiagram, initialize, copy, success, error } = vi.hoisted(() => ({
  renderDiagram: vi.fn(),
  initialize: vi.fn(),
  copy: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/lib/clipboard', () => ({ copyToClipboard: copy }))
vi.mock('sonner', () => ({ toast: { success, error } }))
vi.mock('mermaid', () => ({ default: { initialize, render: renderDiagram } }))

beforeEach(() => {
  vi.clearAllMocks()
  document.documentElement.classList.remove('dark')
  copy.mockResolvedValue(undefined)
  renderDiagram
    .mockReset()
    .mockResolvedValue({ svg: '<svg><text>Step A</text></svg>' })
})

describe('MermaidBlock', () => {
  it('groups view choices and keeps icon actions accessible', async () => {
    render(<MermaidBlock source="flowchart TD; A --> B" />)
    await screen.findByText('Step A')
    expect(screen.getByRole('group', { name: 'Diagram view' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Diagram' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    expect(screen.getByRole('button', { name: 'Copy code' }).textContent).toBe(
      ''
    )
    expect(
      screen.getByRole('button', { name: 'Enlarge diagram' }).textContent
    ).toBe('')
    fireEvent.click(screen.getByRole('radio', { name: 'Diagram' }))
    expect(screen.getByRole('radio', { name: 'Diagram' })).toHaveAttribute(
      'aria-checked',
      'true'
    )
  })
  it('uses SVG labels so sanitization cannot strip the diagram text', async () => {
    render(<MermaidBlock source="flowchart TD; A --> B" />)
    await screen.findByText('Step A')
    expect(initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        secure: expect.arrayContaining(['htmlLabels', 'flowchart']),
      })
    )
  })
  it('reports clipboard errors without claiming success', async () => {
    copy.mockRejectedValue(new Error('denied'))
    render(<MermaidBlock source="flowchart TD; A --> B" />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith('Unable to copy code')
    )
    expect(success).not.toHaveBeenCalled()
  })

  it('rerenders when the applied theme changes', async () => {
    render(<MermaidBlock source="flowchart TD; A --> B" />)
    await screen.findByText('Step A')
    await act(async () => {
      document.documentElement.classList.add('dark')
    })
    await waitFor(() =>
      expect(initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'dark' })
      )
    )
    await screen.findByText('Step A')
  })
  it('renders a diagram, switches to source and opens an enlarged view', async () => {
    render(<MermaidBlock source={'flowchart TD\nA --> B'} />)
    await screen.findByText('Step A')
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false })
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Code' }))
    expect(screen.getByText(/flowchart TD/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Diagram' }))
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge diagram' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('keeps invalid source readable', async () => {
    renderDiagram.mockRejectedValue(new Error('invalid'))
    render(<MermaidBlock source="invalid diagram" />)
    await screen.findByRole('alert')
    expect(screen.getByText('invalid diagram')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enlarge diagram' })).toBeNull()
  })

  it('sanitizes generated SVG', async () => {
    renderDiagram.mockResolvedValue({
      svg: '<svg><script>alert(1)</script><text onclick="alert(1)">Safe</text></svg>',
    })
    const { container } = render(
      <MermaidBlock source="flowchart TD; A --> B" />
    )
    await screen.findByText('Safe')
    expect(container.querySelector('script, [onclick]')).toBeNull()
  })

  it('ignores a stale render after the source changes', async () => {
    let resolve: (value: { svg: string }) => void = () => undefined
    renderDiagram.mockImplementationOnce(
      () =>
        new Promise(r => {
          resolve = r
        })
    )
    const { rerender } = render(<MermaidBlock source="old" />)
    await waitFor(() => expect(renderDiagram).toHaveBeenCalled())
    rerender(<MermaidBlock source="new" />)
    resolve({ svg: '<svg><text>Old</text></svg>' })
    await screen.findByText('Step A')
    expect(screen.queryByText('Old')).toBeNull()
  })
})
