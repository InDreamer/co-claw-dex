import { describe, expect, test } from 'bun:test'
import { buildCitationDisplayItems } from './citations.js'

describe('citations', () => {
  test('deduplicates repeated URL citations and preserves clickable urls', () => {
    const result = buildCitationDisplayItems([
      {
        type: 'url_citation',
        title: 'OpenAI Docs',
        url: 'https://developers.openai.com',
      },
      {
        type: 'url_citation',
        title: 'OpenAI Docs',
        url: 'https://developers.openai.com',
      },
    ])

    expect(result).toEqual({
      items: [
        {
          text: 'OpenAI Docs',
          url: 'https://developers.openai.com',
        },
      ],
      overflow: 0,
    })
  })

  test('formats document and file citations into readable reference labels', () => {
    const result = buildCitationDisplayItems([
      {
        type: 'page_location',
        document_title: 'Architecture Report',
        start_page_number: 3,
        end_page_number: 4,
      },
      {
        type: 'file_citation',
        filename: 'notes.txt',
        index: 17,
      },
    ])

    expect(result.items).toEqual([
      {
        text: 'Architecture Report (pages 3-4)',
      },
      {
        text: 'notes.txt (match 17)',
      },
    ])
  })
})
