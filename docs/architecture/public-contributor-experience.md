# Public contributor experience

## Problem and decision

A feature list and an operator setup guide do not show a first-time visitor how the pieces fit together. The project tour follows a fictional group from trip creation to shared decisions and during-trip adjustments. It separates the working web app from the optional agent preview and future product direction.

A static walkthrough is intentionally available without API keys, a database, or a live trip. A link to a shared writable production trip would give strangers join/edit access, make the example mutable and potentially spend a host's provider quota. No such link or identity-restoring credential is published. This tour is not an interactive sandbox, seeded local environment, or a promise of hosted service availability.

## Contributor entry points

GitHub issue forms request reproduction steps and user problems while steering vulnerability reports to private reporting. Bug reports use fictional examples and variable names rather than secret values. Feature requests distinguish desired behavior from claims that it is already supported. Issue forms collect reports; they do not redact submitted text automatically, guarantee response times, or replace maintainer review.

The contribution guide lists bounded documentation, accessibility and test work and explains which larger product areas need design discussion. Historical private PR numbers remain provenance, not instructions for new contributors to find inaccessible discussions.

## Validation and rollback

Check local documentation destinations, parse issue-form YAML, and run the repository's tests, lint and build. Review the public diff for private trip links and credentials. No app code, schema, model calls or connector settings change. Revert the documentation/forms PR for rollback. Changes to these files do not certify later agent lifecycle stages or live WhatsApp behavior.
