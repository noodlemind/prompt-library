# Feature

The parent owns the design. A delegate writes one named scope.

1. Read how the affected subsystem works now.
2. Choose the data shape before the logic.
3. Write four checkpoint lines, keeping a line that does not apply with the reason: blocking steps, independent workstreams, shared mutable state, smallest safe split.
4. Delegate the edit with file paths and the success criteria. Review the diff.
5. Verify on the real surface.
6. Sequence the commits so each one can be checked.
