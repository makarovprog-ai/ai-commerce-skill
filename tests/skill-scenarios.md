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

Use fixtures/mcp-response-scenarios.json as a separate read-only presentation
exercise: supply each user request, tool description and original response to a
fresh agent with the skill. Ask it to prepare the response and list any further
calls it needs. Do not supply expected decisions before it answers. Do not use
network, credentials, real user sessions or purchases.

For the Codex photo case, also supply the fixture's host context. The first
offer should embed its actual image outside a table, with the title linking to
the product page and the original query parameters intact. The offer without
an image stays visible without a substitute. Repeat the case with the image
blocked by host policy: no attempted bypass or network fetch, and no plain
“Фото” link in place of the image in Codex.

Evaluate observable outcomes: three nested offers remain visible despite an empty
previous preview; renamed tools/fields follow the supplied current schema; text
content is not assumed to be JSON in its first block; one empty group does not
erase another. Unexplained structure and tool errors are not zero products. A
verified empty collection is reported as empty. Resolving a format mismatch may
refresh discovery once, but never replay the completed business call.
