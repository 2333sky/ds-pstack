#!/usr/bin/env node
/**
 * Verify that the vendored `skills/` tree still matches `skills.manifest.json`.
 *
 * The manifest records sha256 of every file as taken from
 * cursor/plugins@pstack@ae5650fe. Any edited, added, or missing file fails here.
 *
 * Usage:
 *   node scripts/check-vendor.mjs                       # verify against the manifest
 *   node scripts/check-vendor.mjs --source <dir>        # also diff the tree against a live checkout
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MANIFEST_PATH = join(ROOT, 'skills.manifest.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walk(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.isFile()) files.push(full)
    else throw new Error(`unexpected non-file entry: ${full}`)
  }
  return files
}

function toKey(base, file) {
  return relative(base, file).split(sep).join('/')
}

function parseArgs(argv) {
  const sourceIndex = argv.indexOf('--source')
  if (sourceIndex === -1) return { source: undefined }
  const source = argv[sourceIndex + 1]
  if (!source) throw new Error('--source requires a directory')
  return { source: resolve(source) }
}

function main() {
  const { source } = parseArgs(process.argv.slice(2))
  if (!existsSync(MANIFEST_PATH)) throw new Error(`missing manifest: ${MANIFEST_PATH}`)
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
  const root = join(ROOT, manifest.root)
  if (!existsSync(root)) throw new Error(`missing vendored root: ${root}`)

  const expected = manifest.files
  const actualFiles = walk(root)
  const actual = new Map(actualFiles.map((file) => [toKey(root, file), file]))

  const missing = Object.keys(expected).filter((key) => !actual.has(key))
  const extra = [...actual.keys()].filter((key) => !(key in expected))
  const mismatched = []
  for (const [key, file] of actual) {
    if (!(key in expected)) continue
    const digest = sha256(file)
    if (digest !== expected[key]) mismatched.push({ key, expected: expected[key], actual: digest })
  }

  let sourceResult = ''
  if (source !== undefined) {
    if (!existsSync(source)) throw new Error(`missing --source directory: ${source}`)
    const sourceFiles = walk(source)
    const sourceKeys = new Map(sourceFiles.map((file) => [toKey(source, file), file]))
    const onlyInSource = [...sourceKeys.keys()].filter((key) => !actual.has(key))
    const onlyInVendor = [...actual.keys()].filter((key) => !sourceKeys.has(key))
    const byteDiffs = []
    for (const [key, file] of actual) {
      if (!sourceKeys.has(key)) continue
      const vendored = readFileSync(file)
      const upstream = readFileSync(sourceKeys.get(key))
      if (!vendored.equals(upstream)) byteDiffs.push(key)
    }
    sourceResult =
      ` source_checked=${sourceKeys.size}` +
      ` source_only=${onlyInSource.length}` +
      ` vendor_only=${onlyInVendor.length}` +
      ` byte_diff=${byteDiffs.length}`
    if (onlyInSource.length > 0) console.error(`only in source: ${onlyInSource.join(', ')}`)
    if (onlyInVendor.length > 0) console.error(`only in vendor: ${onlyInVendor.join(', ')}`)
    if (byteDiffs.length > 0) console.error(`byte differences: ${byteDiffs.join(', ')}`)
    if (onlyInSource.length + onlyInVendor.length + byteDiffs.length > 0) {
      console.log(`FILES=${actual.size} manifest_ok=${missing.length + extra.length + mismatched.length === 0}${sourceResult}`)
      process.exitCode = 1
      return
    }
  }

  for (const key of missing) console.error(`missing: ${key}`)
  for (const key of extra) console.error(`unexpected: ${key}`)
  for (const item of mismatched) console.error(`hash mismatch: ${item.key} expected=${item.expected} actual=${item.actual}`)

  const ok = missing.length + extra.length + mismatched.length === 0
  console.log(
    `upstream=${manifest.upstream.repo}@${manifest.upstream.sha}` +
      ` files=${actual.size} manifest_files=${Object.keys(expected).length}` +
      ` missing=${missing.length} extra=${extra.length} mismatched=${mismatched.length}${sourceResult}`,
  )
  console.log(ok ? 'VENDOR_OK' : 'VENDOR_FAILED')
  if (!ok) process.exitCode = 1
}

main()
