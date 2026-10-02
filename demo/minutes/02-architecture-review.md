# Payments Platform Migration: Architecture Review

**Date:** 2026-09-15
**Attendees:** Sarah Chen, Raj Patel, Ana Silva, Mei Wong (Security)
**Whiteboard:** photo attached

## Notes
- Raj presented the target architecture. His action item "draft the target architecture for the API Gateway" is done.
- The API Gateway now also routes to a new Auth Service.
- Mei Wong leads the Security Team, which owns the Auth Service.
- The API migration depends on the Auth Service.

## Decisions
- Decision: keep the legacy Ledger running until the dual-run cutover is complete.

## Blockers
- PCI audit: the audit has not been done. It blocks the Payments Service go-live and the Checkout launch.

## Action items
- Mei Wong: schedule the PCI audit with the external assessor (due 2026-09-26).
- Sarah Chen: budget confirmation with Finance is in progress.
