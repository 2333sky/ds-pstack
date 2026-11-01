/**
 * Minimal YAML frontmatter reader for vendored pstack skills.
 *
 * Only the subset the upstream corpus actually uses is supported:
 *   - `key: plain scalar` (single line)
 *   - `key: "double quoted"` with backslash escapes
 *   - `key: 'single quoted'` with '' escapes
 *   - `key: >-` / `|` folded / literal block scalars
 *   - `key: [a, b]` inline arrays of quoted strings
 *
 * It deliberately does not implement general YAML: a malformed field must fail
 * loudly for that one skill instead of being silently misread.
 */

const KEY_LINE = /^([A-Za-z0-9_-]+):(.*)$/

/**
 * Split a markdown document into its frontmatter mapping and body.
 * @param {string} text - full SKILL.md content.
 * @returns {{ data: Record<string, unknown>, body: string, bodyStartLine: number, keys: string[] }}
 */
export function parseSkillMarkdown(text) {
  if (typeof text !== 'string') throw new TypeError('skill markdown must be a string')
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const lines = source.split(/\r?\n/)
  if (lines[0].trim() !== '---') throw new Error('missing leading "---" frontmatter delimiter')

  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end === -1) throw new Error('missing closing "---" frontmatter delimiter')

  const data = parseMapping(lines.slice(1, end))
  const body = lines.slice(end + 1).join('\n')
  return { data, body, bodyStartLine: end + 2, keys: Object.keys(data) }
}

/** Parse the frontmatter mapping lines (without the delimiters). */
function parseMapping(lines) {
  const data = {}
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    if (/^\s/.test(line)) throw new Error(`unexpected indented line outside a block scalar: ${JSON.stringify(line)}`)

    const match = KEY_LINE.exec(line)
    if (!match) throw new Error(`not a "key: value" line: ${JSON.stringify(line)}`)
    const key = match[1]
    const rawRest = match[2]

    if (Object.prototype.hasOwnProperty.call(data, key)) throw new Error(`duplicate frontmatter key "${key}"`)

    const trimmed = rawRest.trim()
    if (isBlockIndicator(trimmed)) {
      const collected = []
      let cursor = index + 1
      while (cursor < lines.length) {
        const next = lines[cursor]
        if (next.trim() === '') {
          collected.push('')
          cursor += 1
          continue
        }
        if (!/^\s/.test(next)) break
        collected.push(next)
        cursor += 1
      }
      if (cursor > index + 1) index = cursor - 1
      data[key] = parseBlockScalar(trimmed, collected)
      continue
    }

    data[key] = parseInlineValue(trimmed, key)
  }
  return data
}

function isBlockIndicator(value) {
  return /^[>|][+-]?\s*(?:#.*)?$/.test(value)
}

function parseBlockScalar(indicator, collected) {
  const style = indicator[0]
  const chomp = /[+-]/.test(indicator) ? indicator[1] : ''
  const indents = collected.filter((line) => line.trim() !== '').map((line) => /^\s*/.exec(line)[0].length)
  const indent = indents.length > 0 ? Math.min(...indents) : 0
  const lines = collected.map((line) => (line.trim() === '' ? '' : line.slice(indent)))

  let value
  if (style === '|') {
    value = lines.join('\n')
  } else {
    value = fold(lines)
  }
  value = value.replace(/\n+$/, '')
  if (chomp === '') value += '\n'
  if (chomp === '+') value += '\n'
  return value
}

function fold(lines) {
  let out = ''
  let pendingBreak = false
  for (const line of lines) {
    if (line === '') {
      pendingBreak = true
      continue
    }
    if (out === '') {
      out = line
    } else if (pendingBreak) {
      out += `\n${line}`
    } else {
      out += ` ${line}`
    }
    pendingBreak = false
  }
  return out
}

function parseInlineValue(trimmed, key) {
  if (trimmed === '' || trimmed === '~' || trimmed === 'null') return null
  if (trimmed.startsWith('"')) return parseDoubleQuoted(trimmed, key)
  if (trimmed.startsWith("'")) return parseSingleQuoted(trimmed, key)
  if (trimmed.startsWith('[')) return parseInlineArray(trimmed, key)
  return trimmed
}

function parseDoubleQuoted(trimmed, key) {
  const end = findClosingQuote(trimmed, '"')
  if (end === -1) throw new Error(`unterminated double-quoted value for "${key}"`)
  const inner = trimmed.slice(1, end)
  return inner.replace(/\\(["\\/bfnrt])/g, (_match, escape) => {
    switch (escape) {
      case 'b': return '\b'
      case 'f': return '\f'
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      default: return escape
    }
  })
}

function parseSingleQuoted(trimmed, key) {
  const end = trimmed.indexOf("'", 1)
  if (end === -1) throw new Error(`unterminated single-quoted value for "${key}"`)
  return trimmed.slice(1, end).replace(/''/g, "'")
}

function findClosingQuote(value, quote) {
  for (let index = value.length - 1; index > 0; index -= 1) {
    if (value[index] !== quote) continue
    let backslashes = 0
    for (let cursor = index - 1; cursor > 0 && value[cursor] === '\\'; cursor -= 1) backslashes += 1
    if (backslashes % 2 === 0) return index
  }
  return -1
}

function parseInlineArray(trimmed, key) {
  if (!trimmed.endsWith(']')) throw new Error(`unterminated inline array for "${key}"`)
  const inner = trimmed.slice(1, -1).trim()
  if (inner === '') return []
  const items = []
  let current = ''
  let quote = ''
  for (const char of inner) {
    if (quote !== '') {
      current += char
      if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    if (char === ',') {
      items.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (quote !== '') throw new Error(`unterminated quote in inline array for "${key}"`)
  if (current.trim() !== '') items.push(current.trim())
  return items.map((item) => {
    if (item.startsWith('"')) return parseDoubleQuoted(item, key)
    if (item.startsWith("'")) return parseSingleQuoted(item, key)
    return item
  })
}

/**
 * Normalize a YAML-ish boolean. Accepts the spellings YAML 1.1/1.2 allow.
 * @returns {boolean | undefined} undefined when the value is not a boolean.
 */
export function parseBoolean(value) {
  if (value === true || value === false) return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (['true', 'yes', 'on', '1'].includes(normalized)) return true
  if (['false', 'no', 'off', '0'].includes(normalized)) return false
  return undefined
}

/**
 * Pull the routing hint out of an upstream description: pstack writes it as a
 * final `Use for ...` sentence instead of a dedicated field.
 *
 * Only a `Use for` that starts a sentence is treated as the hint; anything else
 * returns undefined rather than guessing.
 */
export function extractWhenToUse(description) {
  if (typeof description !== 'string' || description.length === 0) return undefined
  const match = /(?:^|[.!?]\s+)Use for\s+/.exec(description)
  if (!match) return undefined
  const offset = match[0].indexOf('Use for')
  const tail = description.slice(match.index + offset).trim()
  if (tail.length <= 'Use for'.length) return undefined
  return tail
}
