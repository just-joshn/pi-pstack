---- MODULE Latch ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == \/ x = 0 /\ x' = 1
        \/ x = 1 /\ x' = 1
NeverTwo == x < 2
====
