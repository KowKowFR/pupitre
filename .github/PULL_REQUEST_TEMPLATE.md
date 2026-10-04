<!--
Thank you. This template is short on purpose: what it asks for is what review
will look at anyway. Delete the sections that do not apply.
Full guide: CONTRIBUTING.md
-->

## What this changes

<!-- Two or three sentences. The effect, not the list of files touched. -->

Closes #

## What I ran

<!--
Paste the REAL OUTPUT, not a ticked box. "Works on my machine" is not a
verification. The base is the CI's:
-->

```
pnpm build:packages
pnpm -r typecheck
pnpm exec tsc --noEmit -p scripts/tsconfig.json
pnpm --filter @pupitre/web lint
pnpm --filter @pupitre/core test
pnpm test:schedule
pnpm test:ai
```

<!--
And the verification scripts concerned by what you touch, with their last line.
If you could not run one — no target, no cluster, no AI key — SAY SO here rather
than leaving it out.
-->

## The project's rules

- [ ] No new `if (runtime === ...)` outside the drivers.
      `grep -rn "runtime === '" apps packages --include='*.ts' --include='*.tsx' | grep -v /drivers/ | grep -v /dist/`
      still returns no line.
- [ ] No long-running operation in an HTTP route: it goes through BullMQ.
- [ ] The audit log goes through `logAudit()`, not through a scattered insert.
- [ ] No secret in clear — neither in the database, nor in the logs, nor in an API
      response, nor in this diff.
- [ ] No existing migration was changed, renamed or deleted. New ones were read
      by hand.
- [ ] A new protected route goes through `requirePermission()`.
- [ ] What a user reads goes through a dictionary, in French and in English.
- [ ] The relevant documentation is up to date in this same pull request.

## What is missing, or what I am not sure about

<!--
A pull request honest about its gaps reads better than a silent one. What you
could not verify, what you suspect, what you left for later: it goes here.
-->
