# Exhaustive TypeScript switches

In a switch over a discriminated union or an enum, put a `never` check in the default case, so that adding a variant fails type checking until every switch handles it.
