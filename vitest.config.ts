import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
      vendor: fileURLToPath(new URL('./vendor', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'test/**/*.test.ts', '__tests__/**/*.test.ts'],
    passWithNoTests: true,
    restoreMocks: true,
    clearMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      provider: 'v8',
      enabled: false,
      all: true,
      clean: true,
      reportsDirectory: 'coverage/repo',
      reporter: ['text-summary', 'json-summary', 'json'],
      include: ['src/**/*.{ts,js,mjs}', 'cli.js'],
      exclude: [
        'vendor/**',
        'dist/**',
        'tests/**',
        'test/**',
        '__tests__/**',
        'docs/**',
        '**/*.md',
        'coverage/**',
        'autoresearch*.md',
        'autoresearch*.jsonl',
        'autoresearch*.sh',
        'autoresearch.ideas.md',
        'scripts/**',
        'stubs/**',
        'node_modules/**',
        '**/.vitest*/**',
      ],
    },
  },
})
