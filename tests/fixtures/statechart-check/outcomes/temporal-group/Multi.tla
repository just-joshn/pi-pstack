---- MODULE Multi ----
EXTENDS Naturals
VARIABLE x
Init == x = 0
Next == /\ x < 3
        /\ x' = x + 1
Safe == x < 3
First == []<>(x < 3)
Second == []<>(x >= 0)
====
