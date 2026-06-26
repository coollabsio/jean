import { describe, expect, it } from 'vitest'
import { extractToolArtifacts, sanitizeToolOutput } from './tool-artifacts'

describe('tool artifacts', () => {
  it('extracts Canva generated design thumbnails', () => {
    const output = JSON.stringify({
      job: {
        result: {
          generated_designs: [
            {
              candidate_id: 'dg-1',
              url: 'https://www.canva.com/d/example',
              thumbnail: {
                url: 'https://design.canva.ai/preview-token',
              },
            },
          ],
        },
      },
    })

    const artifacts = extractToolArtifacts({
      name: 'mcp:canva:generate_design',
      output,
    })

    expect(artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          title: 'Preview',
          url: 'https://design.canva.ai/preview-token',
        }),
      ])
    )
  })

  it('extracts Canva design view and edit actions from nested text payloads', () => {
    const output = JSON.stringify([
      {
        type: 'text',
        text: JSON.stringify({
          design_summary: {
            id: 'DAHM6Wfi2oE',
            title: 'AR-Bidder Russian Instagram Post',
            urls: {
              edit_url: 'https://www.canva.com/d/edit-id',
              view_url: 'https://www.canva.com/d/view-id',
            },
          },
        }),
      },
    ])

    const artifacts = extractToolArtifacts({
      name: 'mcp:canva:create_design_from_candidate',
      output,
    })

    expect(artifacts).toContainEqual(
      expect.objectContaining({
        type: 'link',
        title: 'AR-Bidder Russian Instagram Post',
        url: 'https://www.canva.com/d/view-id',
        actions: [
          { label: 'Edit', url: 'https://www.canva.com/d/edit-id' },
          { label: 'View', url: 'https://www.canva.com/d/view-id' },
        ],
      })
    )
  })


  it('groups thumbnails with nested Canva actions instead of duplicating link cards', () => {
    const output = JSON.stringify({
      title: 'Grouped Canva card',
      thumbnail: {
        url: 'https://design.canva.ai/grouped-preview',
      },
      urls: {
        edit_url: 'https://www.canva.com/d/edit-grouped',
        view_url: 'https://www.canva.com/d/view-grouped',
      },
    })

    const artifacts = extractToolArtifacts({
      name: 'mcp:canva:get_design_pages',
      output,
    })

    expect(artifacts).toContainEqual(
      expect.objectContaining({
        type: 'image',
        title: 'Grouped Canva card',
        url: 'https://design.canva.ai/grouped-preview',
        actions: [
          { label: 'Edit', url: 'https://www.canva.com/d/edit-grouped' },
          { label: 'View', url: 'https://www.canva.com/d/view-grouped' },
        ],
      })
    )
    expect(artifacts.filter(artifact => artifact.type === 'link')).toHaveLength(0)
  })

  it('extracts local file paths from text output', () => {
    const artifacts = extractToolArtifacts({
      name: 'Write',
      output: 'Saved report to /home/niko/tmp/report.pdf',
    })

    expect(artifacts).toContainEqual(
      expect.objectContaining({
        type: 'file',
        title: 'report.pdf',
        path: '/home/niko/tmp/report.pdf',
      })
    )
  })

  it('redacts image preview URLs from raw output when previews exist', () => {
    const output = JSON.stringify({
      thumbnail: {
        url: 'https://document-export.canva.com/file.png?X-Amz-Signature=abc',
      },
    })
    const artifacts = extractToolArtifacts({
      name: 'mcp:canva:get_design_pages',
      output,
    })

    expect(sanitizeToolOutput(output, artifacts)).not.toContain(
      'X-Amz-Signature'
    )
  })

  it('does not crash on broken JSON', () => {
    expect(
      extractToolArtifacts({
        name: 'tool',
        output: '{"not": "closed"',
      })
    ).toEqual([])
  })
})
