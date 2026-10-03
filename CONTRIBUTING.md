# Contributing

Thank you for helping improve pi-warm-cache.

## Development setup

Use Node.js 24 with TypeScript stripping support and pnpm 10 for development checks.
Run dependency installation and project commands inside Docker Sandboxes, not on the host.

From the project directory, create a sandbox that shares only this workspace:

```bash
sbx create --name pi-warm-cache-dev --skills off shell "$PWD"
sbx exec --workdir "$PWD" pi-warm-cache-dev npm install --prefix /tmp/pi-warm-node node@24.21.0
sbx exec --workdir "$PWD" pi-warm-cache-dev bash -lc '
  set -e
  export PATH=/tmp/pi-warm-node/node_modules/node/bin:$PATH
  node --version
  corepack pnpm install --frozen-lockfile
  corepack pnpm test
  corepack pnpm exec tsc --noEmit
  corepack pnpm lint
'
```

The sandbox workspace has the same path as the host project directory.
`sbx exec` starts a stopped sandbox.
Stop it with `sbx stop pi-warm-cache-dev`.
No development server, port mapping, or local URL is required for these checks.

`pnpm test` runs the unit suite and an offline check through Pi's real extension loader and Responses adapter.
The host check uses synthetic HTTP responses, an isolated configuration directory, and a dummy API key.
It blocks outbound requests and disables native warming.
It does not verify live cache preservation or native/extension ownership safety.
CI checks Pi 0.84.2 with pi-tui 0.84.4 and Pi 1.0.0.

`pnpm lint` uses the local anti-slop plugin in `tools/oxlint/anti-slop/`.
See [Slice 1 verification](docs/pi-v1-compatibility-plan.md#slice-1-verification) for the exact research sandbox and runtime used.

## Changes

Use a feature branch for each change.

Keep provider capability decisions explicit and fail closed for unknown routes.

Preserve exact provider payload replay.

Do not add provider credentials, prompt contents, or other private data to commits, tests, logs, or issue reports.

Update the README or the E2E guide when behavior, supported routes, configuration, or commands change.

Add regression coverage for provider strategy, payload shaping, diagnostics, or lifecycle changes.

## Pull requests

Explain the user-visible behavior and the affected provider routes.

Include the test and type-check commands that you ran.

Call out any live provider validation that was not possible in the local environment.

A maintainer will review the pull request before it is merged.
