# jobicy-cli

CLI behind the `jobicy-search` skill: searches remote job listings from **[Jobicy](https://jobicy.com)** through its public
JSON API (v2). No authentication, no API key, zero runtime dependencies. Its
server-side `geo` filter has `latam` and `mexico` slugs, which makes it a direct
source of remote roles explicitly open to Mexico.

**Authentication**: none. **Dependencies**: none (plain `bun` + `fetch`);
`bun install` is optional and only pulls TypeScript dev types.

## Usage

```bash
cd .agents/skills/jobicy-search/cli
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
