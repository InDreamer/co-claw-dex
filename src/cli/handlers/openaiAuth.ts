/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { BRAND_NAME } from '../../constants/brand.js'
import {
  getOpenAIApiKey,
  loadCodexAuthConfig,
  loadCodexProviderConfig,
  resolveOpenAIBaseUrl,
  resolveOpenAIModel,
  shouldStoreOpenAIResponses,
} from '../../services/modelBackend/openaiCodexConfig.js'
import { errorMessage } from '../../utils/errors.js'
import { jsonStringify } from '../../utils/slowOperations.js'

type ApiKeySource = 'OPENAI_API_KEY' | '~/.codex/auth.json' | 'none'

function getApiKeySource(): ApiKeySource {
  if (process.env.OPENAI_API_KEY?.trim()) {
    return 'OPENAI_API_KEY'
  }
  if (loadCodexAuthConfig().openaiApiKey) {
    return '~/.codex/auth.json'
  }
  return 'none'
}

async function validateConfiguredKey(): Promise<{
  ok: boolean
  error?: string
}> {
  const apiKey = getOpenAIApiKey()
  if (!apiKey) {
    return {
      ok: false,
      error:
        'No API key is configured. Expected OPENAI_API_KEY or ~/.codex/auth.json.',
    }
  }

  try {
    const response = await fetch(`${resolveOpenAIBaseUrl()}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: jsonStringify({
        model: resolveOpenAIModel(undefined),
        input: [
          {
            role: 'user',
            content: [{ type: 'input_text', text: 'Reply with exactly ok' }],
          },
        ],
        max_output_tokens: 8,
        store: false,
      }),
    })

    if (response.ok) {
      return { ok: true }
    }

    const text = await response.text()
    let message = text
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } }
      message = parsed.error?.message || text
    } catch {
      // Fall back to raw text
    }

    return {
      ok: false,
      error: message || `Responses request failed with status ${response.status}`,
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function getStatusPayload() {
  const provider = loadCodexProviderConfig()
  const apiKeySource = getApiKeySource()

  return {
    loggedIn: apiKeySource !== 'none',
    authMethod: apiKeySource === 'none' ? 'none' : 'openai_api_key',
    apiProvider: 'openaiResponses',
    providerId: provider.providerId,
    baseUrl: resolveOpenAIBaseUrl(),
    model: resolveOpenAIModel(undefined),
    wireApi: provider.wireApi,
    storeResponses: shouldStoreOpenAIResponses(),
    apiKeySource: apiKeySource === 'none' ? null : apiKeySource,
  }
}

export async function authLogin(): Promise<void> {
  const status = getStatusPayload()
  if (!status.loggedIn) {
    process.stderr.write(
      `${BRAND_NAME} uses OpenAI/Codex-style file or environment credentials.\n` +
        'Set OPENAI_API_KEY or add OPENAI_API_KEY to ~/.codex/auth.json, then retry.\n',
    )
    process.exit(1)
  }

  const validation = await validateConfiguredKey()
  if (!validation.ok) {
    process.stderr.write(
      `Configured OpenAI/Codex credentials failed validation: ${validation.error}\n`,
    )
    process.exit(1)
  }

  process.stdout.write(
    `${BRAND_NAME} is ready to use the configured OpenAI/Codex credentials.\n`,
  )
  process.exit(0)
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const status = getStatusPayload()

  if (opts.text) {
    process.stdout.write(`Backend: OpenAI/Codex Responses\n`)
    process.stdout.write(`Provider: ${status.providerId}\n`)
    process.stdout.write(`Model: ${status.model}\n`)
    process.stdout.write(`Base URL: ${status.baseUrl}\n`)
    process.stdout.write(`Wire API: ${status.wireApi}\n`)
    process.stdout.write(`Store responses: ${status.storeResponses}\n`)
    process.stdout.write(
      `API key: ${status.apiKeySource ?? 'not configured'}\n`,
    )
    if (!status.loggedIn) {
      process.stdout.write(
        `Not configured. Set OPENAI_API_KEY or ~/.codex/auth.json.\n`,
      )
    }
  } else {
    process.stdout.write(jsonStringify(status, null, 2) + '\n')
  }

  process.exit(status.loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  process.stdout.write(
    `${BRAND_NAME} does not manage OpenAI/Codex credentials directly.\n` +
      'Remove OPENAI_API_KEY from the environment or edit ~/.codex/auth.json if you want to disable this backend.\n',
  )
  process.exit(0)
}
