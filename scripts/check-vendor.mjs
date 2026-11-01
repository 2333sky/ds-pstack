#!/usr/bin/env node
/**
 * Verify that the vendored `skills/` tree still matches `skills.manifest.json`.
 *
 * The manifest is a lock file: it records the upstream source (repository,
 * subdirectory, commit, version, license, retrieval time), an inventory
 * (file count, total bytes, hash algorithm) and per-file sha256 + byte size as
 * taken from cursor/plugins@pstack@ae5650fe. Any edited, added, or missing
 * file fails here, as does a size or inventory mismatch.
 *
 * Usage:
 *   node scripts/check-vendor.mjs                       # verify against the manifest
 *   node scripts/check-vendor.mjs --source <dir>        # also diff the tree against a live checkout
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const MANIFEST_PATH = join(ROOT, 'skills.manifest.json')

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** HEAD of the checkout containing `dir`, or undefined when it is not a git work tree. */
function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
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

function manifestOk(missing, extra, mismatched, sizeMismatched, inventoryErrors) {
  return String(
    missing.length + extra.length + mismatched.length + sizeMismatched.length + inventoryErrors.length === 0,
  )
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
  const sizeMismatched = []
  let actualTotalBytes = 0
  for (const [key, file] of actual) {
    actualTotalBytes += statSync(file).size
    if (!(key in expected)) continue
    const expectedFile = expected[key]
    const digest = sha256(file)
    if (digest !== expectedFile.sha256) {
      mismatched.push({ key, expected: expectedFile.sha256, actual: digest })
    }
    const size = statSync(file).size
    if (size !== expectedFile.bytes) {
      sizeMismatched.push({ key, expected: expectedFile.bytes, actual: size })
    }
  }

  const inventoryErrors = []
  if (manifest.inventory?.fileCount !== actual.size) {
    inventoryErrors.push(`fileCount expected=${manifest.inventory?.fileCount} actual=${actual.size}`)
  }
  if (manifest.inventory?.totalBytes !== actualTotalBytes) {
    inventoryErrors.push(`totalBytes expected=${manifest.inventory?.totalBytes} actual=${actualTotalBytes}`)
  }
  if (manifest.inventory?.hashAlgorithm !== 'sha256') {
    inventoryErrors.push(`hashAlgorithm expected=sha256 actual=${manifest.inventory?.hashAlgorithm}`)
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
    const head = gitHead(source)
    const expectedCommit = manifest.source?.commit
    const headMatches = head !== undefined && expectedCommit !== undefined && head === expectedCommit
    if (head === undefined) {
      console.warn(`warning: cannot read git HEAD of ${source}; skipping commit check`)
    } else if (!headMatches) {
      console.error(`source HEAD ${head} does not match manifest.source.commit ${expectedCommit}`)
    }
    sourceResult =
      ` source_checked=${sourceKeys.size}` +
      ` source_only=${onlyInSource.length}` +
      ` vendor_only=${onlyInVendor.length}` +
      ` byte_diff=${byteDiffs.length}` +
      ` source_head=${head ?? 'unavailable'}` +
      ` head_match=${head === undefined ? 'unavailable' : headMatches}`
    if (onlyInSource.length > 0) console.error(`only in source: ${onlyInSource.join(', ')}`)
    if (onlyInVendor.length > 0) console.error(`only in vendor: ${onlyInVendor.join(', ')}`)
    if (byteDiffs.length > 0) console.error(`byte differences: ${byteDiffs.join(', ')}`)
    if (onlyInSource.length + onlyInVendor.length + byteDiffs.length > 0 || (head !== undefined && !headMatches)) {
      console.log(`FILES=${actual.size} manifest_ok=${manifestOk(missing, extra, mismatched, sizeMismatched, inventoryErrors)}${sourceResult}`)
      process.exitCode = 1
      return
    }
  }

  for (const key of missing) console.error(`missing: ${key}`)
  for (const key of extra) console.error(`unexpected: ${key}`)
  for (const item of mismatched) console.error(`hash mismatch: ${item.key} expected=${item.expected} actual=${item.actual}`)
  for (const item of sizeMismatched) console.error(`size mismatch: ${item.key} expected=${item.expected} actual=${item.actual}`)
  for (const message of inventoryErrors) console.error(`inventory: ${message}`)

  const ok = manifestOk(missing, extra, mismatched, sizeMismatched, inventoryErrors) === 'true'
  console.log(
    `source=${manifest.source.repository}@${manifest.source.commit} version=${manifest.source.version}` +
      ` files=${actual.size} manifest_files=${Object.keys(expected).length}` +
      ` total_bytes=${actualTotalBytes}` +
      ` missing=${missing.length} extra=${extra.length} mismatched=${mismatched.length}` +
      ` size_mismatched=${sizeMismatched.length} inventory_errors=${inventoryErrors.length}${sourceResult}`,
  )
  console.log(ok ? 'VENDOR_OK' : 'VENDOR_FAILED')
  if (!ok) process.exitCode = 1
}

main()
