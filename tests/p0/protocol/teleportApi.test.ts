import { beforeEach, describe, expect, it, vi } from 'vitest'

const axiosPostMock = vi.hoisted(() => vi.fn())
const axiosPatchMock = vi.hoisted(() => vi.fn())

vi.mock('crypto', () => ({
  randomUUID: () => 'generated-uuid-123',
}))
vi.mock('axios', () => ({
  default: {
    post: (...args: unknown[]) => axiosPostMock(...args),
    patch: (...args: unknown[]) => axiosPatchMock(...args),
    isAxiosError: (error: unknown) =>
      Boolean(error && typeof error === 'object' && (error as any).isAxiosError),
  },
}))
vi.mock('src/constants/oauth.js', () => ({
  getOauthConfig: () => ({ BASE_API_URL: 'https://api.example.com' }),
}))
vi.mock('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org-teleport-1',
}))
vi.mock('../../../src/utils/auth.js', () => ({
  getClaudeAIOAuthTokens: () => ({ accessToken: 'oauth-token-1' }),
}))
vi.mock('../../../src/utils/debug.js', () => ({
  logForDebugging: vi.fn(),
}))
vi.mock('../../../src/utils/log.js', () => ({
  logError: vi.fn(),
}))
vi.mock('../../../src/utils/detectRepository.js', () => ({
  parseGitHubRepository: () => undefined,
}))
vi.mock('../../../src/utils/errors.js', () => ({
  errorMessage: (error: unknown) =>
    error instanceof Error ? error.message : String(error),
  toError: (error: unknown) =>
    error instanceof Error ? error : new Error(String(error)),
}))
vi.mock('../../../src/utils/lazySchema.js', () => ({
  lazySchema: (factory: () => unknown) => factory,
}))
vi.mock('../../../src/utils/sleep.js', () => ({
  sleep: async () => {},
}))
vi.mock('../../../src/utils/slowOperations.js', () => ({
  jsonStringify: (value: unknown) => JSON.stringify(value),
}))

import {
  getOAuthHeaders,
  sendEventToRemoteSession,
  updateSessionTitle,
} from '../../../src/utils/teleport/api.ts'

beforeEach(() => {
  axiosPostMock.mockReset()
  axiosPatchMock.mockReset()
})

describe('teleport/api protocol contracts', () => {
  it('[P0:protocol] constructs stable OAuth headers for remote Sessions API calls', () => {
    expect(getOAuthHeaders('oauth-token-1')).toEqual({
      Authorization: 'Bearer oauth-token-1',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    })
  })

  it('[P0:protocol] sends one user event with the caller UUID and treats HTTP 201 as a successful remote-session post', async () => {
    axiosPostMock.mockResolvedValue({ status: 201, data: { ok: true } })

    await expect(
      sendEventToRemoteSession(
        'session-post-1',
        [{ type: 'text', text: 'hello remote' }],
        { uuid: 'caller-uuid-1' },
      ),
    ).resolves.toBe(true)

    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/sessions/session-post-1/events',
      {
        events: [
          {
            uuid: 'caller-uuid-1',
            session_id: 'session-post-1',
            type: 'user',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: [{ type: 'text', text: 'hello remote' }],
            },
          },
        ],
      },
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer oauth-token-1',
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'ccr-byoc-2025-07-29',
          'x-organization-uuid': 'org-teleport-1',
        },
        timeout: 30000,
      }),
    )
  })

  it('[P0:protocol] falls back to a generated UUID for remote user events and returns false for non-success status or failed title patches', async () => {
    axiosPostMock.mockResolvedValueOnce({ status: 409, data: { error: 'stale session' } })
    axiosPatchMock.mockResolvedValueOnce({ status: 409, data: { error: 'conflict' } })

    await expect(
      sendEventToRemoteSession('session-post-2', 'plain text without caller uuid'),
    ).resolves.toBe(false)
    await expect(updateSessionTitle('session-title-1', 'New Title')).resolves.toBe(false)

    expect(axiosPostMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/sessions/session-post-2/events',
      {
        events: [
          {
            uuid: 'generated-uuid-123',
            session_id: 'session-post-2',
            type: 'user',
            parent_tool_use_id: null,
            message: {
              role: 'user',
              content: 'plain text without caller uuid',
            },
          },
        ],
      },
      expect.any(Object),
    )
    expect(axiosPatchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/sessions/session-title-1',
      { title: 'New Title' },
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer oauth-token-1',
          'x-organization-uuid': 'org-teleport-1',
          'anthropic-beta': 'ccr-byoc-2025-07-29',
        }),
      }),
    )
  })
})
