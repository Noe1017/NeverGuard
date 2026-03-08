# NeverGuard Agent Notes

## Purpose

This project is a small Node.js service for NeverGuard / shMonad exchange-rate monitoring.

## Working Rules

- Keep startup context light. Prefer reading only the files needed for the current task.
- Respect [`.ignore`](/Users/noe1017/src/NeverGuard/.ignore) and avoid scanning ignored paths unless the task explicitly requires it.
- Make minimal, targeted changes. Do not rewrite large files without a clear reason.

## Key Files

- [`package.json`](/Users/noe1017/src/NeverGuard/package.json): scripts and dependencies
- [`server.js`](/Users/noe1017/src/NeverGuard/server.js): main application entry
- [`index.html`](/Users/noe1017/src/NeverGuard/index.html): frontend page
- [`tokens.json`](/Users/noe1017/src/NeverGuard/tokens.json): token configuration/data
- [`README.md`](/Users/noe1017/src/NeverGuard/README.md): minimal project overview

## Commands

- Start app: `npm start`
- Dev run: `npm run dev`

## New Session Hand-off

When starting a new session, the user should ideally provide:

- the current goal
- the files or folders to check first
- any constraints such as "frontend only" or "do not change API behavior"
