#!/usr/bin/env node
/**
 * Refresh contract for the ds-pstack provider.
 *
 * DSH caches the skill *catalog* (names + descriptions) but never the body, so:
 *   - adding or removing a skill directory must become visible through
 *     `list()` once the registry invalidates;
 *   - editing an existing SKILL.md needs no invalidation;
 *   - the provider asks the registry to invalidate after a debounced directory
 *     change, and stops doing so once the registration's signal aborts.
 *
 * Runs with the Node test runner: `node --test scripts/provider-refresh.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSkillProvider } from '../lib/provider.js'

const quiet = { warn() {} }

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'ds-pstack-refresh-'))
}

function writeSkill(skillsDir, name) {
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Fixture skill ${name}.\n---\n\n# ${name}\n\nBody for ${name}.\n`,
  )
  return dir
}

async function waitFor(predicate, timeoutMs = 4000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return predicate()
}

test('a skill directory added at runtime is listed', async () => {
  const skillsDir = makeDir()
  try {
    writeSkill(skillsDir, 'alpha')
    const provider = createSkillProvider({ skillsDir, logger: quiet, watch: false })
    assert.deepEqual((await provider.list({})).map((entry) => entry.name), ['alpha'])

    writeSkill(skillsDir, 'beta')
    assert.deepEqual((await provider.list({})).map((entry) => entry.name), ['alpha', 'beta'])
  } finally {
    rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('a skill directory removed at runtime disappears', async () => {
  const skillsDir = makeDir()
  try {
    writeSkill(skillsDir, 'alpha')
    const beta = writeSkill(skillsDir, 'beta')
    const provider = createSkillProvider({ skillsDir, logger: quiet, watch: false })
    assert.equal((await provider.list({})).length, 2)

    rmSync(beta, { recursive: true, force: true })
    assert.deepEqual((await provider.list({})).map((entry) => entry.name), ['alpha'])
  } finally {
    rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('five rapid changes are coalesced into one invalidate()', async () => {
  const skillsDir = makeDir()
  const controller = new AbortController()
  let invalidations = 0
  try {
    writeSkill(skillsDir, 'alpha')
    const provider = createSkillProvider({
      skillsDir,
      logger: quiet,
      control: { signal: controller.signal, invalidate: () => { invalidations += 1 } },
      watchDebounceMs: 50,
    })
    assert.equal((await provider.list({})).length, 1)

    for (const name of ['beta', 'gamma', 'delta', 'epsilon', 'zeta']) writeSkill(skillsDir, name)

    const called = await waitFor(() => invalidations > 0)
    assert.equal(called, true, `invalidate() was not called (count=${invalidations})`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(invalidations, 1, `expected one coalesced invalidate, got ${invalidations}`)
    assert.equal((await provider.list({})).length, 6)
  } finally {
    controller.abort()
    rmSync(skillsDir, { recursive: true, force: true })
  }
})

test('aborting the registration signal stops invalidation', async () => {
  const skillsDir = makeDir()
  const controller = new AbortController()
  let invalidations = 0
  try {
    writeSkill(skillsDir, 'alpha')
    createSkillProvider({
      skillsDir,
      logger: quiet,
      control: { signal: controller.signal, invalidate: () => { invalidations += 1 } },
      watchDebounceMs: 25,
    })
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 100))

    writeSkill(skillsDir, 'beta')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(invalidations, 0, `invalidate() ran after abort (count=${invalidations})`)
  } finally {
    rmSync(skillsDir, { recursive: true, force: true })
  }
})
