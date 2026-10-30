# Feature

The Engineer owns the design and delivery. Use a delegate for an independently useful scope.

1. Read how the affected subsystem works now.
2. Choose the data shape before the logic.
3. Check dependencies and shared mutable state before splitting independent work.
4. Implement directly when the work is coherent for one owner. Delegate when expertise, isolation, or useful parallelism improves the outcome; provide file paths and success criteria. Before finishing, confirm the diff is the smallest change that meets those criteria.
5. Verify on the real surface.
6. Sequence the commits so each one can be checked.
