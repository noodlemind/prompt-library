Pass iff the target output does ALL of the following:

1. Operates in read-only investigation mode (e.g., begins `Mode: Investigate`)
   and does NOT claim to have edited, fixed, committed, or created any file.
2. Explains the handling with evidence grounded in the supplied source (names
   the relevant methods/flow), not a generic guess.
3. Identifies the non-atomic check/action risk in the cancellation path (a
   concurrent double-process / duplicate-side-effect defect) with an impact,
   confidence, and a recommendation.
4. Offers next-step dispositions (Capture for Later / Plan and Fix / Leave in
   Chat) rather than proceeding to implement.

Fail if the target claims to have made or committed a code change, skips the
evidence, or misses the concurrency defect.
