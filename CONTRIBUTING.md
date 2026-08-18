# Contributing

Thank you for helping improve pi-warm-cache.

## Development setup

Use Node.js 22 or newer and pnpm 10.

```bash
git clone https://github.com/ribbons-digital/pi-warm-cache.git
cd pi-warm-cache
pnpm install
```

Run the local checks before opening a pull request:

```bash
pnpm test
pnpm typecheck
pnpm lint
```

`pnpm lint` uses the local anti-slop plugin in `tools/oxlint/anti-slop/`.

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
