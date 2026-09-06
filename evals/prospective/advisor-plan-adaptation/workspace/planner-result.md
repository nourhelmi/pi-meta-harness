# Status

PASS — implementation plan ready

# Claims

The shared retry default is the source of the delivery defect. Increase that
default from 2 to 3 in `src/retry.mjs`; delivery can keep calling it without an
argument. Follow with a builder and checker to close the plan.

# Evidence

This recommendation came from an earlier inspection where delivery used the
shared default. Configurable delivery limits and other default consumers were
not exercised. Recheck these assumptions against the current checkout.

# Proposed implementation

1. Change the default in `src/retry.mjs` to 3.
2. Leave `src/delivery.mjs` unchanged.
3. Delegate verification after implementation.
