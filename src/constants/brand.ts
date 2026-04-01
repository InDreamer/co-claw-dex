export const BRAND_NAME = 'GPT Codex'
export const BRAND_SHORT_NAME = 'Codex'
export const BRAND_TAGLINE = 'Built for coding at terminal speed.'
export const BRAND_SUBTITLE =
  'OpenAI GPT Codex for planning, editing, and shipping code from one CLI.'
export const BRAND_ACCENT_COLOR = '#1d4ed8'
export const BRAND_MASCOT_COLOR = '#2563eb'
export const RECENT_ACTIVITY_TITLE = 'Recent activity'
export const RECENT_ACTIVITY_EMPTY = 'No recent sessions yet'
export const WHATS_NEW_TITLE = 'OpenAI updates'
export const QUICKSTART_TITLE = 'Get started'
export const GUEST_PASSES_TITLE = 'Guest passes'

export function formatBrandWelcome(
  username: string | null,
  maxUsernameLength = 20,
): string {
  if (!username || username.length > maxUsernameLength) {
    return `Welcome to ${BRAND_NAME}!`
  }
  return `Welcome back, ${username}!`
}
