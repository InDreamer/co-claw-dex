import { describe, expect, test } from 'bun:test'
import {
  buildOpenAICustomToolCallStreamText,
  buildOpenAIContentPartKey,
  extractOpenAIResponseMessageBlocks,
  extractOpenAIResponseReasoningText,
  isOpenAIDisplayOnlyNativeItemType,
  summarizeOpenAINativeStreamItem,
  summarizeOpenAINativeOutputItem,
} from './openaiResponsesOutput.js'

describe('openaiResponsesOutput', () => {
  test('maps output_text annotations into Claude-style citations', () => {
    const blocks = extractOpenAIResponseMessageBlocks({
      id: 'msg_1',
      content: [
        {
          type: 'output_text',
          text: 'Answer with citation',
          annotations: [
            {
              type: 'url_citation',
              title: 'OpenAI Docs',
              url: 'https://developers.openai.com',
            },
          ],
        },
      ],
    })

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'Answer with citation',
        citations: [
          {
            type: 'url_citation',
            title: 'OpenAI Docs',
            url: 'https://developers.openai.com',
          },
        ],
      },
    ])
  })

  test('uses streamed annotation fallback when completed output omits annotations', () => {
    const streamedAnnotations = new Map([
      [
        buildOpenAIContentPartKey('msg_2', 0),
        [
          {
            type: 'file_citation',
            file_id: 'file_123',
            filename: 'report.pdf',
            index: 17,
          },
        ],
      ],
    ])

    const blocks = extractOpenAIResponseMessageBlocks(
      {
        id: 'msg_2',
        content: [{ type: 'output_text', text: 'Answer from file' }],
      },
      streamedAnnotations,
    )

    expect(blocks[0]?.citations).toEqual([
      {
        type: 'file_citation',
        file_id: 'file_123',
        filename: 'report.pdf',
        index: 17,
      },
    ])
  })

  test('prefers reasoning summaries over raw reasoning text', () => {
    const text = extractOpenAIResponseReasoningText({
      summary: [
        { type: 'summary_text', text: 'step 1' },
        { type: 'summary_text', text: 'step 2' },
      ],
      content: [{ type: 'reasoning_text', text: 'raw chain of thought' }],
    })

    expect(text).toBe('step 1\n\nstep 2')
  })

  test('maps output_audio transcripts into text blocks for transcript fidelity', () => {
    const blocks = extractOpenAIResponseMessageBlocks({
      id: 'msg_audio',
      content: [
        {
          type: 'output_audio',
          transcript: 'Spoken answer',
        },
      ],
    })

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'Spoken answer',
        citations: [],
      },
    ])
  })

  test('summarizes native web search items for display-only transcript fallback', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'web_search_call',
      id: 'ws_1',
      action: {
        type: 'search',
        query: 'responses api streaming events',
        sources: [{ title: 'Docs', url: 'https://developers.openai.com' }],
      },
    })

    expect(summary).toContain('[OpenAI native item: web_search_call]')
    expect(summary).toContain('action: search')
    expect(summary).toContain('query: responses api streaming events')
    expect(summary).toContain('sources: 1')
    expect(summary).toContain('source_preview: Docs')
  })

  test('summarizes MCP tool calls with argument and result previews', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'mcp_tool_call',
      id: 'mcp_1',
      server_label: 'docs',
      tool_name: 'search',
      arguments: {
        query: 'responses api',
      },
      result: {
        hits: 3,
      },
    })

    expect(summary).toContain('[OpenAI native item: mcp_tool_call]')
    expect(summary).toContain('server_label: docs')
    expect(summary).toContain('tool_name: search')
    expect(summary).toContain('arguments:')
    expect(summary).toContain('"query": "responses api"')
    expect(summary).toContain('result:')
    expect(summary).toContain('"hits": 3')
  })

  test('summarizes file search items with result preview names', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'file_search_call',
      id: 'fs_1',
      query: 'migration plan',
      results: [
        { filename: 'phase-1.md' },
        { title: 'phase-2.md' },
      ],
    })

    expect(summary).toContain('[OpenAI native item: file_search_call]')
    expect(summary).toContain('query: migration plan')
    expect(summary).toContain('results: 2')
    expect(summary).toContain('result_preview: phase-1.md, phase-2.md')
  })

  test('marks display-only native item types explicitly', () => {
    expect(isOpenAIDisplayOnlyNativeItemType('web_search_call')).toBe(true)
    expect(isOpenAIDisplayOnlyNativeItemType('image_generation_call')).toBe(true)
    expect(isOpenAIDisplayOnlyNativeItemType('custom_tool_call')).toBe(true)
    expect(isOpenAIDisplayOnlyNativeItemType('function_call')).toBe(false)
  })

  test('builds low-noise stream summaries for native items', () => {
    const summary = summarizeOpenAINativeStreamItem({
      type: 'mcp_tool_call',
      server_label: 'docs',
      tool_name: 'search',
      status: 'completed',
      arguments: {
        query: 'responses api',
      },
    })

    expect(summary).toContain('[OpenAI native item: mcp_tool_call]')
    expect(summary).toContain('server_label: docs')
    expect(summary).toContain('tool_name: search')
    expect(summary).toContain('status: completed')
    expect(summary).not.toContain('arguments:')
  })

  test('builds custom tool stream text with inline input body', () => {
    const summary = buildOpenAICustomToolCallStreamText(
      {
        type: 'custom_tool_call',
        name: 'delegate',
        call_id: 'ct_1',
        status: 'in_progress',
      },
      'hello world',
    )

    expect(summary).toContain('[OpenAI native item: custom_tool_call]')
    expect(summary).toContain('name: delegate')
    expect(summary).toContain('call_id: ct_1')
    expect(summary).toContain('input:\nhello world')
  })

  test('summarizes code interpreter output types when outputs are included', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'code_interpreter_call',
      status: 'completed',
      code: 'print(1)',
      outputs: [
        { type: 'logs', content: '1' },
        { type: 'image', url: 'https://example.com/chart.png' },
      ],
    })

    expect(summary).toContain('[OpenAI native item: code_interpreter_call]')
    expect(summary).toContain('outputs: 2')
    expect(summary).toContain('output_types: logs, image')
    expect(summary).toContain('input:')
  })

  test('summarizes computer call output image urls when included', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'computer_call_output',
      status: 'completed',
      output: {
        image_url: 'https://example.com/screenshot.png',
      },
    })

    expect(summary).toContain('[OpenAI native item: computer_call_output]')
    expect(summary).toContain('image_urls: 1')
    expect(summary).toContain(
      'image_url_preview: https://example.com/screenshot.png',
    )
  })

  test('summarizes image generation calls without leaking base64 payloads', () => {
    const summary = summarizeOpenAINativeOutputItem({
      type: 'image_generation_call',
      status: 'completed',
      revised_prompt: 'A warm illustration of a cat hugging an otter.',
      result: 'QUJDREVGR0g=',
      partial_image_count: 2,
    })

    expect(summary).toContain('[OpenAI native item: image_generation_call]')
    expect(summary).toContain('status: completed')
    expect(summary).toContain('partial_images: 2')
    expect(summary).toContain('result_bytes: 12')
    expect(summary).toContain('revised_prompt:')
    expect(summary).not.toContain('QUJDREVGR0g=')
  })

  test('keeps image generation stream summaries low-noise', () => {
    const summary = summarizeOpenAINativeStreamItem({
      type: 'image_generation_call',
      status: 'generating',
      partial_image_count: 1,
      result: 'QUJDREVGR0g=',
    })

    expect(summary).toContain('[OpenAI native item: image_generation_call]')
    expect(summary).toContain('status: generating')
    expect(summary).toContain('partial_images: 1')
    expect(summary).toContain('result_bytes: 12')
    expect(summary).not.toContain('QUJDREVGR0g=')
  })
})
