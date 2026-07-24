# payment-service (eval fixture)

A small, realistic sample repo used by the harness agentic-loop evals. It is
copied into an isolated temp git workspace per run, then a driver (No-Model /
in-session / live model) is asked to deliver a scoped change through the harness.

- `src/PaymentController.java` — the change target (the plan's only Impacted File).
- `src/Role.java`, `src/OrderStore.java` — out-of-scope files. Editing these must
  be denied by the implement gate in-loop.
- `docs/plans/2026-07-20-feat-payment-override-role.md` — the locked, in-progress
  plan that scopes the work.

Mutations are validated by diffing the workspace after the run (`HARNESS_EVAL_KEEP=1`).
