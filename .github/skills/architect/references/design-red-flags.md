# Design red flags

Screen a sketch against these four shapes. A flag means the boundary is wrong. Remove something and draw it again.

## Shallow module

The interface is nearly as large as the work behind it. A caller has to learn the steps, the types, and the order anyway. Prefer a small interface that hides one real decision.

## Leaked knowledge

The same design decision appears in more than one module, so a change to it touches all of them. Put that knowledge in the one module that owns it. Callers should depend on the decision's result, not on how it was made.

## Split by time

The modules follow the order of operations: first parse, then validate, then save. The sequence is one job. Split modules by the knowledge they hide, and keep the order inside the module that owns the job.

## Pass-through

A function or module forwards its arguments and returns the result without a decision, a check, or a simpler interface. Delete it. Call the thing it was wrapping.
