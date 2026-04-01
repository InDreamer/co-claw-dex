export type OpenAIResponseOutputText = {
  type: 'output_text'
  text: string
}

export type OpenAIErrorPayload = {
  error?: {
    message?: string
  }
}

export type OpenAIResponseMessage = {
  type: 'message'
  id?: string
  role: 'assistant'
  content?: OpenAIResponseOutputText[]
}

export type OpenAIResponseFunctionCall = {
  type: 'function_call'
  id?: string
  call_id: string
  name: string
  arguments: string
}

export type OpenAIResponseOutputItem =
  | OpenAIResponseMessage
  | OpenAIResponseFunctionCall
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
      type: 'response.output_text.delta'
      delta?: string
      output_index?: number
      item_id?: string
      content_index?: number
    }
  | {
      type: 'response.output_text.done'
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
  | {
      type: string
      [key: string]: unknown
    }
