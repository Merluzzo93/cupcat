## What & why

<!-- What does this change do, and why? Link any related issue. -->

## How I tested

<!-- Commands run, scenarios exercised. For UI, note the window widths you checked. -->

## Checklist

- [ ] `bun run typecheck` passes
- [ ] `bun --filter @cupcat/editor-core test` passes
- [ ] `bun --filter @cupcat/web test` passes
- [ ] Model changes come with a test (`packages/editor-core`)
- [ ] UI changes don't overflow their panels at common widths
- [ ] Exports stay user-initiated (the agent never renders on the user's behalf)
