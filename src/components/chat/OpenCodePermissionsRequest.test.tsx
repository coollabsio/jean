import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { OpenCodePermissionsRequest } from './OpenCodePermissionsRequest'
import type { OpenCodePermissionRequest } from '@/types/chat'

const baseRequest: OpenCodePermissionRequest = {
  request_id: 'per_1',
  opencode_session_id: 'ses_1',
  permission: 'external_directory',
  patterns: ['/tmp/**'],
  always: ['/tmp/**'],
  working_dir: '/home/user/project',
  api_version: 'v1',
}

describe('OpenCodePermissionsRequest', () => {
  it('renders permission details and fires reply handlers', () => {
    const onOnce = vi.fn()
    const onAlways = vi.fn()
    const onReject = vi.fn()

    render(
      <OpenCodePermissionsRequest
        request={baseRequest}
        onOnce={onOnce}
        onAlways={onAlways}
        onReject={onReject}
      />
    )

    expect(
      screen.getByText(/OpenCode needs permission: External directory access/)
    ).toBeInTheDocument()
    expect(screen.getByText('/tmp/**')).toBeInTheDocument()
    expect(screen.getByText('/home/user/project')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow always' }))
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))

    expect(onOnce).toHaveBeenCalledTimes(1)
    expect(onAlways).toHaveBeenCalledTimes(1)
    expect(onReject).toHaveBeenCalledTimes(1)
  })
})
