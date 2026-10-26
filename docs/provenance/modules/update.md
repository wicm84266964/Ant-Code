---
module: src/update
owner: lab-tooling
implementation_status: independent
implementer_old_source_exposure: none
references:
  - lab_contract: src/update/README.md
  - lab_product_doc: docs/deployment/source-self-update.md
  - standard: Node.js built-in filesystem, process, crypto and URL APIs
  - standard: Git fast-forward and npm ci command interfaces
design_notes:
  - Independently implements this project's standalone source-install update lifecycle using existing Ant Code startup and Dashboard contracts.
  - Derives the installation from the running module and validates repository identity, clean state, official HTTPS upstream and fast-forward eligibility before mutation.
  - Uses one explicitly selected proxy or consented direct route for Git and npm without silently falling back or persisting proxy credentials.
  - Prepares dependencies and loads the candidate CLI in isolation before an activity-gated handoff to a detached built-in-only worker.
  - Records durable journal steps and requires old-process exit plus an authenticated new-process ACK matching the target commit, instance and original listener.
  - Preserves project and configuration paths across strict-port restart; ambiguous post-shutdown failures retain evidence for manual recovery rather than automatic rollback.
  - Uses platform and command interfaces, not copied external updater code; no additional third-party implementation or license is attributed by this record.
prohibited_sources_checked:
  - old source code was not copied
  - old inline source maps were not used
---

# Source Update Provenance

The source-update module is an independent implementation for Ant Code's local
source-install lifecycle. Its behavior and integration boundaries are documented
in the project-owned contract and product guide above, with validation in the
`tests/unit/source-update-*.test.ts` and `tests/integration/source-update-*.test.ts`
fixtures. Git and npm are invoked through their command interfaces; Node.js
built-ins provide the runtime primitives, rather than an imported updater library.

This provenance record does not assert a public release or a real public-network
update. Local restart acceptance uses disposable source clones, not this working
checkout; platform validation limitations remain documented in the module contract.
