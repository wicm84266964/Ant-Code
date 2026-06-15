# Ant Code Maintenance Notes

This repository is the Ant Code source tree.

## Development

- Keep runtime source in `src/`.
- Keep executable behavior covered by `tests/`.
- Keep reusable local skills in `config/skills/`.
- Keep public installation, gateway, quickstart, and security notes in `docs/`.
- Do not commit local sessions, transcripts, logs, build outputs, dependency
  folders, private configs, or credentials.

## Verification

Use focused checks while developing:

```powershell
npm run check:syntax
npm run check:dependencies
npm test
```

Use the mock gateway for tests and demos that do not need a real model:

```powershell
npm run mock-gateway -- --port 8787
```

## Compatibility

The public project name is Ant Code. The `lab-agent` name remains in protocol,
config, and local state paths as a compatibility anchor. Do not rename those
surfaces without an explicit migration plan.

## Security

Gateway access tokens and provider credentials must stay outside repository
files. The checked-in `lab-agent.config.json` is an example config only.
