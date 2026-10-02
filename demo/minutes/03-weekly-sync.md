# Payments Platform Migration: Weekly Sync

**Date:** 2026-09-22
**Attendees:** Sarah Chen, Raj Patel, Mei Wong, Tom Becker (SRE)

## Notes
- Tom Becker joins from the SRE Team and reports to Raj Patel. The SRE Team is responsible for the Postgres Database.
- The Fraud Check process feeds into the Payments Service.
- Auth Service latency is blocking the Checkout launch.
- Ana's Ledger integration inventory is in progress.

## Decisions
- Decision: add a Redis Cache in front of the Auth Service to cut token latency.

## Action items
- Tom Becker: load-test the Auth Service with the Redis Cache (due 2026-09-30).
- Raj Patel: provision the Redis Cache (due 2026-09-25).
