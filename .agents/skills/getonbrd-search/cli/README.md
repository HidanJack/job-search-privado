# getonbrd-cli

CLI behind the `getonbrd-search` skill: searches live job listings from **[GetOnBoard](https://www.getonbrd.com)**, the main
Latin American tech job board, through its documented public API for public job
data. No authentication, no API key, zero runtime dependencies. Postings are
mostly in Spanish and include salary ranges (USD per month) far more often than
other boards.

**Authentication**: none. **Dependencies**: none (plain `bun` + `fetch`);
`bun install` is optional and only pulls TypeScript dev types.

## Usage

```bash
cd .agents/skills/getonbrd-search/cli
bun run src/cli.ts --help
bun run src/cli.ts search -q python --format table
bun run src/cli.ts detail <id|url> --format plain
```

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test            # offline: fetch is mocked with fixtures in tests/fixtures/
```

Tests never hit the network. `src/cli.ts` (flag parsing/validation) and the shared
block at the top of `src/helpers.ts` are identical across the five LatAm/remote
portal CLIs; portal-specific mapping lives at the bottom of `src/helpers.ts` and
in `src/commands/`. See `../SKILL.md` for flags and `../url-reference.md` for the API.
