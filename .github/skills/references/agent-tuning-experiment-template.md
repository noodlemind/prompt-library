# Agent Tuning Experiment Template

Use this template for entries in `docs/evals/engineer-harness/tuning-log.md` or a candidate branch notes file.

## Experiment

- **Experiment id:**
- **Date:**
- **Candidate branch:**
- **Owner/reviewer:**
- **Hypothesis:**
- **One changed area:** Prompt / skill / template / check / eval runner docs
- **Files changed:**

## Baseline

| Provider | Model | Cases | Score | P1 pass | Request estimate | Notes |
|---|---|---:|---:|---|---:|---|
|  |  |  |  |  |  |  |

## Candidate Run

| Provider | Model | Cases | Score | P1 pass | Request estimate | Notes |
|---|---|---:|---:|---|---:|---|
|  |  |  |  |  |  |  |

## Decision

- **Decision:** keep / revert / revise
- **Reason:**
- **P1 regressions:** yes / no
- **Human approval:**
- **Copilot localhost confirmation:** required / complete / not applicable yet

## Constraints

- Do not change eval rubric and tuned prompt in the same candidate.
- Add new eval cases in a separate preparatory change.
- Local model or subscription results are advisory until confirmed through Copilot localhost.
