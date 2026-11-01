/**
 * Runtime skill provider for the vendored pstack corpus.
 *
 * The provider exposes every `skills/<name>/SKILL.md` as a DSH skill candidate.
 * Bodies are loaded lazily in `get()`; `list()` only reads enough to produce a
 * summary. Every definition carries a `directory` resource base so the model
 * can read playbooks and references (`skills/<name>/playbooks/...`) with the
 * ordinary file tools — the `skill` tool itself has no sub-path parameter.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractWhenToUse, parseBoolean, parseSkillMarkdown } from './frontmatter.js'

/** Absolute path of the bundled skills directory (`<package>/skills`). */
export const DEFAULT_SKILLS_DIR = fileURLToPath(new URL('../skills', import.meta.url))

const PROVIDER_NAME = 'ds-pstack'
const SKILL_SOURCE = 'runtime'
/** Higher than project (100/200) skills, far below the reserved ranks. */
const SKILL_RANK = 900
const UPSTREAM_SHA = 'ae5650febf4320793844c12c4adaa937f417f8da'
const UPSTREAM_REPO = 'cursor/plugins'
const UPSTREAM_PATH = 'pstack/skills'

/**
 * Build the adapter pointer that prefixes every body. The docs path is resolved
 * at runtime from the skills directory so the package never ships a machine
 * specific path.
 */
function adapterNote(skillsDir) {
  const docsPath = resolve(skillsDir, '..', 'docs', 'harness', 'dsh.md')
  return `> DSH 适配：本 skill 原文来自 cursor/plugins@pstack，工具名映射见 ${docsPath}，首次加载时读一次。`
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Create the `ds-pstack` skill provider.
 *
 * @param {object} [options]
 * @param {string} [options.skillsDir] - directory holding `<name>/SKILL.md`; defaults to the bundled tree.
 * @param {number} [options.rank] - duplicate-name precedence; defaults to 900.
 * @param {{ warn: (message: string) => void }} [options.logger] - receives per-skill parse failures.
 * @returns {{ name: string, list: Function, get: Function }}
 */
export function createSkillProvider(options = {}) {
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR
  const rank = options.rank ?? SKILL_RANK
  const logger = options.logger ?? console
  const cache = new Map()

  function warn(message) {
    logger.warn(`[${PROVIDER_NAME}] ${message}`)
  }

  function readSkill(dir) {
    const skillPath = join(dir, 'SKILL.md')
    let stat
    try {
      stat = statSync(skillPath)
    } catch (error) {
      warn(`skip ${skillPath}: ${error.message}`)
      return undefined
    }
    const cached = cache.get(skillPath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.parsed

    let text
    try {
      text = readFileSync(skillPath, 'utf8')
    } catch (error) {
      warn(`skip ${skillPath}: ${error.message}`)
      return undefined
    }
    let parsed
    try {
      parsed = describeSkill(dir, skillPath, text)
    } catch (error) {
      warn(`skip ${skillPath}: ${error.message}`)
      return undefined
    }
    cache.set(skillPath, { mtimeMs: stat.mtimeMs, size: stat.size, parsed })
    return parsed
  }

  function describeSkill(dir, skillPath, text) {
    const { data, body } = parseSkillMarkdown(text)
    const name = typeof data.name === 'string' ? data.name.trim() : ''
    const description = typeof data.description === 'string' ? data.description.trim() : ''
    if (!name) throw new Error('frontmatter has no "name"')
    if (!SKILL_NAME.test(name)) throw new Error(`"${name}" is not a kebab-case skill name`)
    if (!description) throw new Error('frontmatter has no "description"')
    if (body.trim().length === 0) throw new Error('skill body is empty')

    const upstreamDisable = parseBoolean(data['disable-model-invocation'])
    const upstreamUserInvocable = parseBoolean(data['user-invocable'])

    const upstream = {
      repo: UPSTREAM_REPO,
      path: `${UPSTREAM_PATH}/${dir.split(/[\\/]/).pop()}`,
      sha: UPSTREAM_SHA,
    }
    if (upstreamDisable !== undefined) upstream.disableModelInvocation = upstreamDisable
    else if (typeof data['disable-model-invocation'] === 'string') upstream.disableModelInvocationRaw = data['disable-model-invocation']
    if (upstreamUserInvocable !== undefined) upstream.userInvocable = upstreamUserInvocable
    if (Array.isArray(data.paths)) upstream.paths = data.paths
    if (typeof data.icon === 'string') upstream.icon = data.icon
    if (typeof data.color === 'string') upstream.color = data.color

    const metadata = { upstream }

    return {
      name,
      description,
      whenToUse: extractWhenToUse(description),
      dir,
      path: skillPath,
      rank,
      body,
      metadata,
    }
  }

  /** @returns {object[] | undefined} undefined when the directory itself is unreadable. */
  function candidates() {
    let entries
    try {
      entries = readdirSync(skillsDir, { withFileTypes: true })
    } catch (error) {
      warn(`cannot read skills directory ${skillsDir}: ${error.message}`)
      return undefined
    }
    const out = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const parsed = readSkill(join(skillsDir, entry.name))
      if (parsed === undefined) continue
      out.push(parsed)
    }
    out.sort((left, right) => left.name.localeCompare(right.name))
    return out
  }

  return {
    name: PROVIDER_NAME,

    async list(lookup = {}) {
      if (lookup.signal?.aborted) return []
      const found = candidates()
      // An unreadable skills directory is not an authoritative empty catalog:
      // report it as incomplete so the registry does not cache the result.
      if (found === undefined) return { candidates: [], complete: false }
      // DSH overrides `modelInvocable`: the `skill` tool is the only load path,
      // so the upstream `disable-model-invocation: true` must not hide a skill.
      return found.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SKILL_SOURCE,
        provider: PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: skill.dir },
        path: skill.path,
        rank: skill.rank,
        locator: { dir: skill.dir },
        metadata: skill.metadata,
      }))
    },

    async get(candidate, lookup = {}) {
      if (lookup.signal?.aborted) return undefined
      const dir = candidate?.locator?.dir ?? candidate?.resourceBase?.path
      if (typeof dir !== 'string') return undefined
      const parsed = readSkill(dir)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: { modelInvocable: true, userInvocable: true },
        source: SKILL_SOURCE,
        provider: PROVIDER_NAME,
        resourceBase: { kind: 'directory', path: parsed.dir },
        path: parsed.path,
        metadata: parsed.metadata,
        content: `${adapterNote(skillsDir)}\n\n${parsed.body.replace(/^\s*\n/, '')}`,
      }
    },
  }
}
