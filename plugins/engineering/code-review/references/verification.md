Judge each candidate independently. Trace the named input or state through the actual
caller, guards and changed behavior to its observable outcome. When the cited line is
unchanged, compare the old and new path for what makes the issue reachable or what
stated requirement remains unmet.

- CONFIRMED requires a reachable trigger and its wrong outcome. For a conventions claim,
  quote the applicable rule and the violating change. For a cleanup claim explicitly
  sent for verification, check the claimed cost and whether the suggested fix works.
- PLAUSIBLE applies when the mechanism holds but a realistic runtime, timing or
  configuration condition is uncertain. State which fact would settle it.
- REFUTED requires decisive counterevidence. Cite the guard, invariant, actual behavior,
  or quoted requirement or project rule that disproves the claim. Judge unintended
  consequences of required behavior separately.

Return one verdict per candidate index, with ASCII keys index, verdict and evidence.
Quote or cite the decisive line in evidence.
