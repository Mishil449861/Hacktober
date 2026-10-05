# Payments Platform Migration: Steering Committee

**Date:** 2026-09-29
**Attendees:** Maria Lopez (CTO), Sarah Chen, Ana Silva, Mei Wong, Priya Shah

## Updates
- PCI audit: completed and passed. The blocker is resolved.
- Sarah Chen: the migration budget is confirmed with Finance. Done.
- Ana Silva: the Ledger integration inventory is done.
- The Checkout launch milestone moves from 2026-10-31 to 2026-11-15 because of the Auth Service latency work.
- Priya Shah joins the Payments Team and reports to Ana Silva.

## Risks
- Fraud vendor contract: the contract with the fraud-scoring vendor expires on 2026-10-20 and is not renewed yet. It blocks the Fraud Check process.

## Decisions
- Decision: approve a 15-day delay to the Checkout launch rather than launching without the Redis Cache.

## Action items
- Sarah Chen: renew the fraud vendor contract (due 2026-10-10).
- Priya Shah: write the Checkout launch runbook (due 2026-11-01).
