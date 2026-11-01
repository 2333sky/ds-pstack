/**
 * Runtime skill provider for the vendored pstack corpus.
 *
 * The provider exposes every `skills/<name>/SKILL.md` as a DSH skill candidate.
 * Bodies are loaded lazily in `get()`; `list()` only reads enough to produce a
 * summary. Every definition carries a `directory` resource base so the model
 * can read playbooks and references (`skills/<name>/playbooks/...`) with the
 * ordinary file tools — the `skill` tool itself has no sub-path parameter.
 */

import { readdirSync, readFileSync, statSync, watch } from 'node:fs'
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
const DEFAULT_WATCH_DEBOUNCE_MS = 200

/**
 * Create the `ds-pstack` skill provider.
 *
 * @param {object} [options]
 * @param {string} [options.skillsDir] - directory holding `<name>/SKILL.md`; defaults to the bundled tree.
 * @param {number} [options.rank] - duplicate-name precedence; defaults to 900.
 * @param {{ warn: (message: string) => void }} [options.logger] - receives per-skill parse failures.
 * @param {{ signal?: AbortSignal, invalidate?: () => void }} [options.control] - registration lifecycle; `invalidate` is called after a debounced directory change.
 * @param {boolean} [options.watch] - watch the skills directory; defaults to true (active only with a control).
 * @param {number} [options.watchDebounceMs] - debounce for watcher events; defaults to 200 ms.
 * @returns {{ name: string, list: Function, get: Function }}
 */
export function createSkillProvider(options = {}) {
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR
  const rank = options.rank ?? SKILL_RANK
  const logger = options.logger ?? console
  const control = options.control
  const watchDebounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
  const shouldWatch = options.watch ?? true
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

  /**
   * Watch the skills tree and invalidate the registry catalog after a debounced
   * change, so a skill directory added or removed at runtime becomes visible
   * without a restart. Bodies are never cached by the registry, so editing an
   * existing SKILL.md needs no invalidation.
   *
   * `fs.watch(dir, { recursive: true })` is deliberately not used: on Linux the
   * recursive watcher keeps the event loop alive even after `unref()` (Node 22
   * repro: `node -e "require('node:fs').watch(dir,{recursive:true}).unref()"`
   * never exits). One non-recursive watcher on the skills root plus one per
   * skill directory gives the same coverage and lets the process exit.
   */
  function startWatcher() {
    const invalidate = control?.invalidate
    if (typeof invalidate !== 'function' || skillsDir === undefined) return
    const signal = control?.signal
    if (signal?.aborted) return

    const watchers = new Map()
    let timer
    let closed = false

    const close = () => {
      if (closed) return
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      signal?.removeEventListener?.('abort', close)
      for (const watcher of watchers.values()) {
        try {
          watcher.close()
        } catch {
          // The watcher may already be gone; nothing to release.
        }
      }
      watchers.clear()
    }

    const schedule = () => {
      if (closed || timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        if (!closed) invalidate()
      }, watchDebounceMs)
      timer.unref?.()
    }

    const addWatcher = (dir, onEvent) => {
      if (closed || watchers.has(dir)) return
      try {
        const watcher = watch(dir, onEvent)
        watcher.on?.('error', (error) => {
          warn(`skills watcher stopped for ${dir}: ${error.message}`)
          try {
            watcher.close()
          } catch {
            // Already closed.
          }
          watchers.delete(dir)
        })
        watcher.unref?.()
        watchers.set(dir, watcher)
      } catch (error) {
        if (dir === skillsDir) warn(`cannot watch ${dir}: ${error.message}`)
      }
    }

    /** Watch each skill directory so a late SKILL.md write still invalidates. */
    const syncChildWatchers = () => {
      if (closed) return
      let entries
      try {
        entries = readdirSync(skillsDir, { withFileTypes: true })
      } catch {
        return
      }
      const current = new Set()
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(skillsDir, entry.name)
        current.add(dir)
        addWatcher(dir, (_event, filename) => {
          if (filename === null || filename === undefined || filename === 'SKILL.md') schedule()
        })
      }
      for (const [dir, watcher] of watchers) {
        if (dir === skillsDir || current.has(dir)) continue
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
        watchers.delete(dir)
      }
    }

    addWatcher(skillsDir, () => {
      syncChildWatchers()
      schedule()
    })
    syncChildWatchers()
    signal?.addEventListener?.('abort', close, { once: true })
  }

  if (shouldWatch) startWatcher()

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
