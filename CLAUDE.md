# CLAUDE.md

Guidance for AI assistants (and humans) working in this repository.

## Project overview

Homey Pro app (SDK 3) integrating Salus Quantum thermostats (SQ610/SQ610RF) through the Salus EU cloud. App ID `eu.edwinsmulders.salus`, published to the Homey App Store as "Salus Smart Home".

**Caution**: several shadow-property mappings and mode handlings look wrong but are reverse-engineered device behavior, cross-referenced against the official Salus app. Read the code comments before "fixing" anything in that area.

**Driver id**: the driver is named `salus_sensor` for historical reasons (it started as a sensor-only integration) even though it is a thermostat. Do not rename it: paired devices are bound to the driver id and Homey has no way to migrate them, so a rename would orphan every device on every install. Users only ever see the display name ("Quantum Thermostat"), which is free to change.

## Commands

```bash
npm install            # install dependencies
homey app validate     # validate app manifest and structure
homey app run          # run on the selected Homey (development)
homey app install      # install on the selected Homey
npm run dump:salus     # dump raw cloud API data to debug-output/ (needs SALUS_EMAIL/SALUS_PASSWORD env vars)
```

There is no test suite. Verify changes with `homey app validate` and, for behavior changes, by running against a real Homey.

**WARNING — never use the `--clean` flag** (`homey app install --clean` / `homey app run --clean`) without explicit confirmation from the user. It wipes the app's data on the Homey, which **deletes all paired devices**, breaking flows and losing their insights history permanently.

## Conventions

### Commits

Use [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, imperative and lower-case. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `style`, `test`, `build`, `ci`. Mark breaking changes with `!`.

### Versioning and releases

- Bump the version in **both** `app.json` and `package.json` (keep them identical).
- Add an end-user-facing entry to `.homeychangelog.json` for every released version.
- Follow semver: patch for fixes, minor for features, while pre-1.0.

### Code style

- Plain Node.js (CommonJS, `'use strict'`), no build step, no TypeScript.
- Match the existing style; comments explain device/cloud quirks, not what the code does.
