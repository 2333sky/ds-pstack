#!/usr/bin/env node
/**
 * Smoke test for the ds-pstack plugin without installing it into a profile.
 *
 * It stubs the Cordis context surface the plugin touches, runs the real
 * `apply()` + provider, and asserts the contract the DSH registry relies on:
 * a complete, unique 58-skill catalog, lazily loadable bodies, and a directory
 * resource base so playbooks/references stay readable.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractWhenToUse, parseSkillMarkdown } from '../lib/frontmatter.js'
import { createSkillProvider } from '../lib/provider.js'
import * as plugin from '../lib/index.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SKILLS_DIR = join(ROOT, 'skills')
const EXPECTED_SKILLS = 58
const EXPECTED_FILES = 535

const failures = []
let passes = 0

function check(name, condition, detail = '') {
  if (condition) {
    passes += 1
    return
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`)
}

function catalog() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

async function main() {
  check('plugin name', plugin.name === 'ds-pstack', String(plugin.name))
  check('plugin injects skills', Array.isArray(plugin.inject) && plugin.inject.includes('skills'))

  const providers = []
  const ctx = {
    effect(factory) {
      return factory()
    },
    skills: {
      registerProvider(factory) {
        const provider = factory({ signal: new AbortController().signal, invalidate() {} })
        providers.push(provider)
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  check('apply registers exactly one provider', providers.length === 1, `got ${providers.length}`)
  const provider = providers[0]
  check('provider name', provider?.name === 'ds-pstack', String(provider?.name))

  const candidates = await provider.list({})
  check('list returns 58 candidates', candidates.length === EXPECTED_SKILLS, `got ${candidates.length}`)

  const names = candidates.map((entry) => entry.name)
  check('names are unique', new Set(names).size === names.length)
  const dirs = catalog()
  check(
    'catalog matches vendored directories',
    names.length === dirs.length && dirs.every((dir) => names.includes(dir)),
    `dirs=${dirs.length} names=${names.length}`,
  )

  const bad = candidates.filter(
    (entry) =>
      typeof entry.description !== 'string' ||
      entry.description.length === 0 ||
      entry.source !== 'runtime' ||
      entry.provider !== 'ds-pstack' ||
      entry.rank !== 900 ||
      entry.invocation?.modelInvocable !== true ||
      entry.invocation?.userInvocable !== true ||
      entry.resourceBase?.kind !== 'directory' ||
      !existsSync(entry.resourceBase.path) ||
      !existsSync(join(entry.resourceBase.path, 'SKILL.md')) ||
      typeof entry.locator?.dir !== 'string',
  )
  check('every candidate carries a real resource base and runtime policy', bad.length === 0, bad.map((entry) => entry.name).join(','))

  const withWhen = candidates.filter((entry) => typeof entry.whenToUse === 'string' && entry.whenToUse.startsWith('Use for'))
  check('whenToUse extracted only from a real "Use for" tail', withWhen.length === 25, `got ${withWhen.length}`)

  for (const name of ['poteto-mode', 'how', 'statechart']) {
    const candidate = candidates.find((entry) => entry.name === name)
    check(`candidate exists: ${name}`, candidate !== undefined)
    if (candidate === undefined) continue
    const definition = await provider.get(candidate, {})
    check(`get() returns a body: ${name}`, typeof definition?.content === 'string' && definition.content.length > 200)
    check(
      `body keeps the upstream heading: ${name}`,
      /^> DSH 适配：/.test(definition.content) && definition.content.includes('\n# '),
    )
    check(`resourceBase points at a directory: ${name}`, existsSync(definition.resourceBase.path))
  }

  const poteto = candidates.find((entry) => entry.name === 'poteto-mode')
  const featurePlaybook = join(poteto.resourceBase.path, 'playbooks', 'feature.md')
  check('playbooks are reachable through resourceBase', existsSync(featurePlaybook), featurePlaybook)
  const architect = candidates.find((entry) => entry.name === 'architect')
  check(
    'references are reachable through resourceBase',
    readdirSync(join(architect.resourceBase.path, 'references')).length > 0,
  )

  const unknown = await provider.get({ locator: { dir: join(SKILLS_DIR, 'does-not-exist') } }, {})
  check('get() returns undefined for an unknown locator', unknown === undefined)

  let parsed = 0
  const parseFailures = []
  for (const dir of dirs) {
    const text = readFileSync(join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8')
    try {
      const result = parseSkillMarkdown(text)
      if (!result.data.name || !result.data.description) throw new Error('missing name/description')
      if (!extractWhenToUse(result.data.description) && result.data.description.length === 0) throw new Error('empty description')
      parsed += 1
    } catch (error) {
      parseFailures.push(`${dir}: ${error.message}`)
    }
  }
  check(`frontmatter parsed for all ${EXPECTED_SKILLS} skills`, parsed === EXPECTED_SKILLS && parseFailures.length === 0, parseFailures.join(' | '))

  let fileCount = 0
  const countFiles = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) countFiles(join(dir, entry.name))
      else fileCount += 1
    }
  }
  countFiles(SKILLS_DIR)
  check(`vendored file count is ${EXPECTED_FILES}`, fileCount === EXPECTED_FILES, `got ${fileCount}`)

  console.log(
    `SMOKE skills=${candidates.length} files=${fileCount} frontmatter_parsed=${parsed} ` +
      `when_to_use=${withWhen.length} samples=poteto-mode,how,statechart passes=${passes} failures=${failures.length}`,
  )
  for (const failure of failures) console.error(`FAIL ${failure}`)
  console.log(failures.length === 0 ? 'SMOKE_OK' : 'SMOKE_FAILED')
  if (failures.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
