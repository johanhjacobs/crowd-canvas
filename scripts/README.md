# Scripts

This folder is organized by role:

- `helpers/` - reusable JavaScript helpers imported by the app or tooling
- `smoke/` - lightweight validation scripts used by `npm test`
- `ops/` - operational shell scripts for packaging and load-test support
- `reports/` - report and graph generation utilities

Top-level app entry points like `loadtest.js`, `loadtest2.js`, and `loadtest-matrix.js` stay in the
repo root because they are user-facing commands rather than internal helper scripts.
