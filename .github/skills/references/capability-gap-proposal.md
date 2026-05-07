# Capability Gap Proposal

Use this template when `@engineer` believes the current prompt library lacks a reusable capability. Do not create or modify primitives until the proposal is reviewed and approved by the human liaison.

## Summary

- **Requested outcome:**
- **Observed gap:**
- **Why existing capabilities are insufficient:**
- **User impact if not addressed:**

## Trigger Evidence

List the user request, failure mode, recurring workflow, review miss, or eval case that exposed the gap.

```text
[Paste the relevant prompt, eval failure, review finding, or work log excerpt.]
```

## Existing Primitive Check

Record overlap checks before proposing anything new.

| Area checked | Relevant existing artifact | Reuse or gap decision |
|---|---|---|
| Skills |  |  |
| Agents |  |  |
| Instructions |  |  |
| Prompt wrappers |  |  |
| Review checks |  |  |
| References/assets |  |  |
| Solution docs |  |  |

## Proposed Primitive

- **Primitive type:** Skill / Agent / Instruction / Prompt wrapper / Review check / Reference / Solution doc
- **Proposed name/path:**
- **Boundary reason:** Why this belongs in that primitive type.
- **Expected users:** Human users / `@engineer` / pipeline skill / reviewer / maintainer
- **Required tool authority:** Read-only / edit / terminal / fetch / agent delegation / none

## Behavior Contract

Define what the new or changed primitive must do.

- **Should trigger when:**
- **Should not trigger when:**
- **Inputs:**
- **Outputs:**
- **State changes:**
- **Verification evidence:**
- **Failure handling:**

## Risks

- **Safety risks:**
- **Security/data risks:**
- **Cost/request risks:**
- **Misrouting risks:**
- **Maintenance risks:**

## Eval Coverage

List eval cases that already cover this gap or need to be added before tuning.

| Case id | Priority | Expected behavior |
|---|---|---|
|  |  |  |

## Human Decision

- **Decision:** Approved / rejected / needs changes
- **Reviewer:**
- **Date:**
- **Conditions or required edits:**
