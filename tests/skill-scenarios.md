# Behavioral evaluation

Use fixtures/skill-scenarios.json with the skill and only the relevant references
in a fresh agent context. No live network, credentials, cart or payment calls.
Ask the agent to choose its next calls and user-facing message; record observable
calls/claims against each expected field. Fixtures are examples, not universal
wording assertions. Missing schemas must not be invented.

Also exercise missing images/links, valid product URL redirects, partial query
groups, delivery increasing the total above budget, genuine local-session absence,
trusted device deactivation, temporary provider-check contention and unknown
refresh outcomes. Never interpret a successful CLI envelope as a paid order.

For each supported harness, record actual scenarios and mismatches separately.
An independent simulated run is not proof of all harnesses or real purchases.
Automated protocol tests cover token renewal; tests/updates.test.mjs and
tests/update-install.test.mjs cover updater effects. Neither proves LLM behavior.
