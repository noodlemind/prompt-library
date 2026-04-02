# Document Review Criteria

This file defines WHAT each review persona evaluates. The skill body (SKILL.md) defines HOW the review is orchestrated.

Four personas evaluate documents from complementary perspectives. Each persona's criteria are adapted based on document type (brainstorm, plan, spec).

## Persona: Design

**Focus:** Information architecture, user flows, interaction states, completeness of described behavior.

| Document Type | Evaluation Criteria |
|--------------|-------------------|
| **Brainstorm** | Are user scenarios concrete enough to plan from? Are edge cases identified? Are flows described with clear entry/exit points? |
| **Plan** | Do implementation units cover all described user behaviors? Are UI states complete (loading, error, empty, success)? Are interaction flows traceable from requirement to unit? |
| **Spec** | Are all user-facing behaviors specified with inputs, actions, and expected outputs? Are state transitions documented? Are error states handled? |

**P1 findings:** Missing flows that would cause an implementer to invent behavior. Contradictory user experience descriptions.
**P2 findings:** Incomplete edge case coverage. Missing error states for described interactions.
**P3 findings:** Minor UX clarity improvements. Additional scenario suggestions.

## Persona: Scope

**Focus:** Scope alignment, unjustified complexity, YAGNI violations, scope that exceeds stated goals.

| Document Type | Evaluation Criteria |
|--------------|-------------------|
| **Brainstorm** | Do requirements match the stated problem? Are scope boundaries explicit? Is there speculative complexity beyond the stated need? |
| **Plan** | Do implementation units stay within declared scope boundaries? Are there units that don't trace to any requirement? Is the approach the simplest that satisfies the requirements? |
| **Spec** | Does the specification scope match the problem frame? Are there features described that weren't in requirements? |

**P1 findings:** Scope explicitly contradicts stated boundaries. Requirements that depend on something declared out of scope.
**P2 findings:** Unnecessary abstractions or complexity. Units that don't clearly trace to requirements.
**P3 findings:** Minor scope creep suggestions. Over-specified areas that could be simpler.

## Persona: Coherence

**Focus:** Internal consistency, contradictions between sections, terminology drift, structural issues, ambiguity where two readers would diverge.

| Document Type | Evaluation Criteria |
|--------------|-------------------|
| **Brainstorm** | Do requirements use consistent terminology? Do different sections describe the same behavior consistently? Are key terms defined the same way throughout? |
| **Plan** | Do implementation units match the requirements trace? Do file paths in different units conflict? Are technical decisions consistent across units? Does the plan contradict its own scope boundaries? |
| **Spec** | Are field names, state names, and behavior descriptions consistent? Do examples match the formal specification? |

**P1 findings:** Direct contradictions between sections. Terminology used with conflicting definitions.
**P2 findings:** Ambiguities where readers would reasonably diverge. Inconsistent detail levels across sections.
**P3 findings:** Minor terminology drift. Structural improvements for clarity.

## Persona: Feasibility

**Focus:** Technical feasibility, architecture conflicts, dependency gaps, migration risks, implementability.

| Document Type | Evaluation Criteria |
|--------------|-------------------|
| **Brainstorm** | Are assumptions about technical capabilities accurate? Are there implicit dependencies not called out? Would the described behavior require infrastructure that doesn't exist? |
| **Plan** | Are file paths real? Do dependency chains make sense? Are there circular dependencies between units? Will the approach actually work given the codebase's current state? Are test scenarios realistic? |
| **Spec** | Are described behaviors technically feasible? Are performance constraints realistic? Are integration assumptions valid? |

**P1 findings:** Approach will fail due to architectural constraints. Critical dependency missing or unavailable.
**P2 findings:** Approach is feasible but fragile. Dependency order is likely wrong. Test scenarios don't cover realistic failure modes.
**P3 findings:** Minor feasibility concerns. Suggestions for more robust approaches.
