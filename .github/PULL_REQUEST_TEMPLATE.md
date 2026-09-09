## What changed?

Describe the problem and the solution.

## Why?

Explain the user/developer impact and why this approach is appropriate.

## Validation

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] Relevant unit/integration tests
- [ ] Relevant Electron/Portal smoke tests when applicable
- [ ] I did not add real credentials, private workspace data, personal paths or production identifiers

## Risk review

- [ ] No security boundary changes
- [ ] Security boundary changed and is explained below
- [ ] No persistence/migration impact
- [ ] Persistence/migration impact is explained below

### Security / architecture notes

Describe changes to Electron IPC, process spawning, filesystem access, Portal isolation, MCP capabilities, licensing, updates or other sensitive surfaces.

## DCO

- [ ] My commits include a `Signed-off-by:` trailer (`git commit -s`)
