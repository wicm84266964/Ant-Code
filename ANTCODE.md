# Ant Code Project Rules

Ant Code should prefer this file when loading project rules. `AGENT.md` is kept
for tools that look for that conventional filename.

## Repository Boundary

This is the open-source Ant Code source tree. Work inside the repository should
stay limited to source, tests, sanitized templates, and public documentation.

Do not add:

- `.lab-agent/` sessions, memory, plans, task records, or transcripts
- `logs/`, `.tmp/`, `dist/`, `node_modules/`, coverage output, or build output
- `.env` files, gateway tokens, provider keys, or private local configs
- user project data or model-generated artifacts

## Checks

Before substantial changes, prefer:

```powershell
npm run check:syntax
npm test
```

For release-style review, also run dependency and provenance checks:

```powershell
npm run check:dependencies
npm run check:provenance
```

## Naming

Use **Ant Code** in user-facing text. Preserve `lab-agent` in compatibility
surfaces unless a migration is explicit.
