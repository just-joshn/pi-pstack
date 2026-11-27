---- MODULE Values ----
EXTENDS Naturals
VARIABLES x, ok, color, seen, tags, rec, tup, pairs, range
Init == /\ x = 0
        /\ ok = TRUE
        /\ color = "red"
        /\ seen = {1, 2}
        /\ tags = {"a", "b"}
        /\ rec = [a |-> 1, b |-> {2}]
        /\ tup = <<1, "x">>
        /\ pairs = ("a" :> 1 @@ "b" :> 2)
        /\ range = 1..3
Next == /\ x = 0
        /\ x' = 1
        /\ UNCHANGED <<ok, color, seen, tags, rec, tup, pairs, range>>
Types == x < 1
====
