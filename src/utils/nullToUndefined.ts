import { z } from 'zod/v4'

/**
 * Provider-native strict schemas sometimes require optional-looking fields to
 * be present as `null`. Normalize those placeholders back to `undefined` so
 * the local runtime keeps its existing optional-input semantics.
 */
export function nullToUndefined<T extends z.ZodType>(inner: T) {
  return z.preprocess((value: unknown) => (value === null ? undefined : value), inner)
}
