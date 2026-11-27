---- MODULE Counter ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == /\ x < 3
        /\ x' = x + 1
Parity == x >= 0
NeverThree == x < 3
====
