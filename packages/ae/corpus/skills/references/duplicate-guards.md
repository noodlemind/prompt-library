# Duplicate guards

Before the same edit lands in two or more sites, map the callers and callees on the path you are changing.

List call sites with `ae search <name> --match literal --source code --json`. `ae graph explain` and `ae graph impact` list module imports. They do not list method callers. Do not run rg, grep, or find.

If an outer check is the same or stronger on every path that reaches the inner check, report a likely duplicate guard. Name both locations and the call path. Propose one owner for the condition.

Check every caller of the inner method before calling the inner check redundant. Another caller can reach it without the outer check. Removing a guard needs the user's OK, or the removal must be in scope in the locked plan. Do not copy the change into both places while that question is open.

## Example

`charge` returns when `paid` is already true. It calls `ledger.post`. `ledger.post` calls `account.apply`. `account.apply` returns on the same `paid` check. The path is `charge` to `ledger.post` to `account.apply`. The outer check covers this path. Search every caller of `account.apply` before treating the inner check as redundant. Propose one owner. The finding title is `Redundant guard`.
