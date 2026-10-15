#!/usr/bin/env bun
// Self-contained portal CLI: no CLI framework and zero runtime dependencies,
// so it runs anywhere `bun` is available. Portal-specific behaviour lives in
// commands/search.ts and commands/detail.ts; this file only parses and
// validates flags, then dispatches.

import { HELP, SEARCH_FLAGS, runSearch } from "./commands/search.js"
import { runDetail } from "./commands/detail.js"
import { COMMON_SEARCH_FLAGS, parseFlags, parseIntFlag, stringFlag, writeError, type CommonOpts } from "./helpers.js"

const KNOWN_FLAGS: Record<string, Set<string>> = {
  search: new Set([...COMMON_SEARCH_FLAGS, ...SEARCH_FLAGS, "help", "h"]),
  detail: new Set(["format", "help", "h"]),
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2))
  const cmd = (flags._ as string[])[0]

  if (!cmd || flags.help || flags.h) {
    process.stdout.write(HELP)
    return cmd ? 0 : 1
  }

  // Unknown flags are rejected, never silently dropped: a discarded filter
  // changes what the search returns with no error.
  const known = KNOWN_FLAGS[cmd]
  if (!known) {
    writeError(`Unknown command "${cmd}"`, "BAD_CMD")
    return 1
  }
  for (const key of Object.keys(flags)) {
    if (key === "_" || known.has(key)) continue
    writeError(
      `unknown flag --${key} for '${cmd}' - flags are never silently ignored, because a discarded filter changes what the search returns; see --help for the supported flags`,
      "UNKNOWN_FLAG",
    )
    return 1
  }

  if (cmd === "detail") {
    const id = (flags._ as string[])[1]
    if (!id) {
      writeError("detail requires an <id|url>", "NO_ID")
      return 1
    }
    const fmt = flags.format !== undefined ? String(flags.format) : "json"
    if (fmt !== "json" && fmt !== "plain") {
      writeError(`--format must be one of json|plain, got "${fmt}"`, "BAD_ARG")
      return 1
    }
    return runDetail(id, fmt)
  }

  const fmt = flags.format !== undefined ? String(flags.format) : "json"
  if (!["json", "table", "plain"].includes(fmt)) {
    writeError(`--format must be one of json|table|plain, got "${fmt}"`, "BAD_ARG")
    return 1
  }
  const ints: Record<string, number> = {}
  for (const name of ["jobage", "page", "limit"]) {
    if (flags[name] === undefined) continue
    const v = parseIntFlag(name, flags[name])
    if (v === null) return 1
    ints[name] = v
  }
  for (const name of ["query", "location"]) {
    if (flags[name] === true) {
      writeError(`--${name} requires a value`, "BAD_ARG")
      return 1
    }
  }

  const opts: CommonOpts = {
    query: stringFlag(flags.query),
    location: stringFlag(flags.location),
    jobage: ints.jobage ?? null,
    page: ints.page ?? 1,
    limit: ints.limit ?? 25,
    format: fmt as CommonOpts["format"],
    latam: flags.latam === true || flags.latam === "true",
  }
  return runSearch(opts, flags)
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    writeError(e instanceof Error ? e.message : String(e), "INTERNAL_ERROR")
    process.exit(1)
  })
