/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { BRAND_NAME } from '../../constants/brand.js'
import {
  formatCodexAuthMode,
  formatCodexAuthSource,
  getCodexAuthPath,
  loadCodexAuthConfig,
  loadCodexProviderConfig,
  resolveSelectedCodexAuth,
  resolveCodexConfigPathInfo,
  resolveOpenAIBaseUrl,
  resolveOpenAIModel,
  shouldStoreOpenAIResponses,
} from '../../services/modelBackend/openaiCodexConfig.js'
import { fetchOpenAIResponse } from '../../services/modelBackend/openaiApi.js'
import { errorMessage } from '../../utils/errors.js'
import { renderModelName } from '../../utils/model/model.js'
import { jsonStringify } from '../../utils/slowOperations.js'

async function validateConfiguredCredential(): Promise<{
  ok: boolean
  error?: string
}> {
  try {
    const requestBody = {
      model: resolveOpenAIModel(undefined),
      input: [
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Reply with exactly ok' }],
        },
      ],
      max_output_tokens: 8,
      store: false,
    }
    await fetchOpenAIResponse('/responses', {
      method: 'POST',
      headers: {
        accept: 'application/json',
      },
      body: requestBody,
    })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

function getStatusPayload() {
  const provider = loadCodexProviderConfig()
  const rawAuth = loadCodexAuthConfig()
  const selectedAuth = resolveSelectedCodexAuth()
  const configPathInfo = resolveCodexConfigPathInfo()

  return {
    loggedIn: selectedAuth.isCompatible,
    ready: selectedAuth.isCompatible,
    authMethod:
      selectedAuth.mode === 'none'
        ? 'none'
        : selectedAuth.mode === 'chatgpt'
          ? 'chatgpt_login'
          : 'openai_api_key',
    apiProvider: 'openaiResponses',
    providerId: provider.providerId,
    baseUrl: resolveOpenAIBaseUrl(),
    model: resolveOpenAIModel(undefined),
    wireApi: provider.wireApi,
    storeResponses: shouldStoreOpenAIResponses(),
    configPath: configPathInfo.path,
    configSource: configPathInfo.source,
    authPath: getCodexAuthPath(),
    detectedAuthMode: rawAuth.mode,
    detectedAuthSource:
      rawAuth.source === 'none' ? null : formatCodexAuthSource(rawAuth.source),
    selectedAuthMode: selectedAuth.mode,
    selectedAuthSource:
      selectedAuth.source === 'none'
        ? null
        : formatCodexAuthSource(selectedAuth.source),
    lastRefresh: rawAuth.lastRefresh ?? selectedAuth.lastRefresh ?? null,
    error:
      selectedAuth.incompatibilityReason ||
      selectedAuth.error ||
      rawAuth.error ||
      null,
    transportStatus: 'ready',
  }
}

export async function authLogin(): Promise<void> {
  const status = getStatusPayload()

  if (!status.loggedIn) {
    process.stderr.write(`${status.error ?? 'No OpenAI/Codex credential is configured.'}\n`)
    process.exit(1)
  }

  const validation = await validateConfiguredCredential()
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
    const modelLabel = renderModelName(status.model)
    process.stdout.write(`Backend: OpenAI/Codex\n`)
    process.stdout.write(`Provider: ${status.providerId}\n`)
    process.stdout.write(
      `Model: ${modelLabel === status.model ? status.model : `${modelLabel} (${status.model})`}\n`,
    )
    process.stdout.write(`Base URL: ${status.baseUrl}\n`)
    process.stdout.write(`Wire API: ${status.wireApi}\n`)
    process.stdout.write(`Store responses: ${status.storeResponses}\n`)
    process.stdout.write(`Config path: ${status.configPath}\n`)
    process.stdout.write(`Config source: ${status.configSource}\n`)
    process.stdout.write(`Auth path: ${status.authPath}\n`)
    process.stdout.write(
      `Detected auth: ${formatCodexAuthMode(status.detectedAuthMode)} (${status.detectedAuthSource ?? 'not configured'})\n`,
    )
    process.stdout.write(
      `Selected auth: ${formatCodexAuthMode(status.selectedAuthMode)} (${status.selectedAuthSource ?? 'not configured'})\n`,
    )
    if (status.lastRefresh) {
      process.stdout.write(`Last refresh: ${status.lastRefresh}\n`)
    }
    process.stdout.write(`Transport: ${status.transportStatus}\n`)
    if (status.error) {
      process.stdout.write(`Status: ${status.error}\n`)
    }
  } else {
    process.stdout.write(jsonStringify(status, null, 2) + '\n')
  }

  process.exit(status.loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  process.stdout.write(
    `${BRAND_NAME} does not manage OpenAI/Codex credentials directly.\n` +
      `Remove OPENAI_API_KEY from the environment or edit ${getCodexAuthPath()} if you want to disable this backend.\n`,
  )
  process.exit(0)
}
