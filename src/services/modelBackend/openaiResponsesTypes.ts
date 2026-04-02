export type OpenAIResponseAnnotation = {
  type: string
  [key: string]: unknown
}

export type OpenAIResponseOutputText = {
  type: 'output_text'
  text: string
  annotations?: OpenAIResponseAnnotation[]
  logprobs?: unknown[]
}

export type OpenAIResponseOutputAudio = {
  type: 'output_audio'
  audio?: string
  transcript?: string
  [key: string]: unknown
}

export type OpenAIResponseRefusal = {
  type: 'refusal'
  refusal?: string
  text?: string
  [key: string]: unknown
}

export type OpenAIResponseReasoningContentPart = {
  type?: string
  text?: string
  summary?: string
  [key: string]: unknown
}

export type OpenAIErrorPayload = {
  type?: 'error'
  error?: {
    message?: string
  }
}

export type OpenAIResponseMessage = {
  type: 'message'
  id?: string
  status?: string
  role: 'assistant'
  content?: Array<
    | OpenAIResponseOutputText
    | OpenAIResponseOutputAudio
    | OpenAIResponseRefusal
    | {
        type: string
        text?: string
        refusal?: string
        transcript?: string
        [key: string]: unknown
      }
  >
}

export type OpenAIResponseFunctionCall = {
  type: 'function_call'
  id?: string
  status?: string
  call_id: string
  name: string
  arguments: string
}

export type OpenAIResponseReasoningItem = {
  type: 'reasoning'
  id?: string
  status?: string
  summary?: OpenAIResponseReasoningContentPart[]
  content?: OpenAIResponseReasoningContentPart[]
  encrypted_content?: string
  [key: string]: unknown
}

export type OpenAIResponseCustomToolCall = {
  type: 'custom_tool_call'
  id?: string
  status?: string
  call_id?: string
  name?: string
  input?: string
  [key: string]: unknown
}

export type OpenAIResponseBuiltinToolItem = {
  type:
    | 'code_interpreter_call'
    | 'computer_call'
    | 'computer_call_output'
    | 'file_search_call'
    | 'image_generation_call'
    | 'mcp_call'
    | 'mcp_list_tools'
    | 'mcp_tool_call'
    | 'web_search_call'
  id?: string
  status?: string
  [key: string]: unknown
}

export type OpenAIResponseOutputItem =
  | OpenAIResponseMessage
  | OpenAIResponseFunctionCall
  | OpenAIResponseReasoningItem
  | OpenAIResponseCustomToolCall
  | OpenAIResponseBuiltinToolItem
  | {
      type: string
      [key: string]: unknown
    }

export type OpenAIResponseUsage = {
  input_tokens?: number
  output_tokens?: number
  total_tokens?: number
  input_tokens_details?: {
    cached_tokens?: number
  }
  output_tokens_details?: {
    reasoning_tokens?: number
  }
}

export type OpenAIResponse = {
  id: string
  status?: string
  output?: OpenAIResponseOutputItem[]
  usage?: OpenAIResponseUsage
  service_tier?: string | null
  error?: {
    message?: string
  } | null
}

export type OpenAIModelListEntry = {
  id: string
  object?: string
  created?: number
  owned_by?: string
}

export type OpenAIModelListResponse = {
  object?: string
  data?: OpenAIModelListEntry[]
}

export type OpenAIInputTokenCountResponse = {
  object?: 'response.input_tokens'
  input_tokens?: number
}

export type OpenAIResponsesStreamEvent =
  | {
      type: 'response.created' | 'response.in_progress'
      response?: Partial<OpenAIResponse>
    }
  | {
      type: 'response.output_item.added' | 'response.output_item.done'
      item?: OpenAIResponseOutputItem
      output_index?: number
      item_id?: string
    }
  | {
      type: 'response.content_part.added' | 'response.content_part.done'
      part?:
        | OpenAIResponseOutputText
        | OpenAIResponseOutputAudio
        | OpenAIResponseRefusal
        | OpenAIResponseReasoningContentPart
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.output_text.delta'
      delta?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.output_text.done'
      text?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.output_audio.delta' | 'response.output_audio.done'
      delta?: string
      audio?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type:
        | 'response.output_audio_transcript.delta'
        | 'response.output_audio_transcript.done'
      delta?: string
      transcript?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.output_text.annotation.added'
      annotation?: OpenAIResponseAnnotation
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.refusal.delta'
      delta?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.refusal.done'
      refusal?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type:
        | 'response.function_call_arguments.delta'
        | 'response.function_call_arguments.done'
      delta?: string
      output_index?: number
      item_id?: string
      item?: OpenAIResponseFunctionCall
    }
  | {
      type: 'response.custom_tool_call_input.delta'
      delta?: string
      output_index?: number
      item_id?: string
      item?: OpenAIResponseCustomToolCall
    }
  | {
      type: 'response.custom_tool_call_input.done'
      input?: string
      output_index?: number
      item_id?: string
      item?: OpenAIResponseCustomToolCall
    }
  | {
      type:
        | 'response.image_generation_call.in_progress'
        | 'response.image_generation_call.generating'
        | 'response.image_generation_call.completed'
      output_index?: number
      item_id?: string
    }
  | {
      type: 'response.image_generation_call.partial_image'
      output_index?: number
      item_id?: string
      partial_image_index?: number
      partial_image_b64?: string
    }
  | {
      type:
        | 'response.reasoning_summary_part.added'
        | 'response.reasoning_summary_part.done'
      part?: OpenAIResponseReasoningContentPart
      output_index?: number
      item_id?: string
      summary_index?: number
    }
  | {
      type:
        | 'response.reasoning_summary_text.delta'
        | 'response.reasoning_summary_text.done'
      delta?: string
      text?: string
      output_index?: number
      item_id?: string
      summary_index?: number
    }
  | {
      type: 'response.reasoning_text.delta' | 'response.reasoning_text.done'
      delta?: string
      text?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.completed'
      response: OpenAIResponse
    }
  | {
      type: 'response.failed' | 'response.incomplete'
      response?: {
        error?: { message?: string } | null
        incomplete_details?: { reason?: string } | null
      }
    }
  | (OpenAIErrorPayload & {
      type: 'error'
    })
  | {
      type: string
      [key: string]: unknown
    }
