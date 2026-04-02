import { afterEach, describe, expect, test } from 'bun:test'
import { clearBundledSkills, getBundledSkills } from '../bundledSkills.js'
import { registerSimplifySkill } from './simplify.js'

async function getSimplifyPrompt(): Promise<string> {
  clearBundledSkills()
  registerSimplifySkill()
  const simplify = getBundledSkills().find(skill => skill.name === 'simplify')
  const prompt = await simplify?.getPromptForCommand('', {} as never)
  const firstBlock = prompt?.[0]
  return firstBlock?.type === 'text' ? firstBlock.text : ''
}

afterEach(() => {
  clearBundledSkills()
})

describe('simplify bundled skill prompt', () => {
  test('requires reviewers to read diffs from an absolute file path', async () => {
    const prompt = await getSimplifyPrompt()

    expect(prompt).toContain('absolute file path')
    expect(prompt).toContain('Full output saved to:')
    expect(prompt).toContain(
      'read the diff from the absolute diff file path',
    )
  })

  test('forbids placeholder diff handoff patterns', async () => {
    const prompt = await getSimplifyPrompt()

    expect(prompt).toContain('Never use placeholders or shell substitutions')
    expect(prompt).toContain('$(cat ...)')
    expect(prompt).toContain('not-supported')
    expect(prompt).toContain('"full diff below"')
  })
})
