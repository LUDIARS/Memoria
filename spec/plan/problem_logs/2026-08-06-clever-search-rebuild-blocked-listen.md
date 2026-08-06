---
title: Clever Search rebuilt its projection before every listen
date: 2026-08-06
status: fixed
service: memoria
---

# Clever Search rebuilt its projection before every listen

## Symptom

After Clever Search was introduced, restarting Memoria left port 5180 unavailable
for minutes. Excubitor had a live process, but loopback health could not connect.

## Cause

Router construction created the Clever Search schema and then executed a full
projection UPSERT for every source table. That work ran synchronously before the
HTTP server was created, even when a complete projection from the previous run
already existed.

## Resolution

Schema and trigger installation remains idempotent on every start. Source seeding
now runs only when the projection table is empty. The initial seed is atomic with
schema initialization, and source-table triggers keep an existing projection
current after that point.

## Regression coverage

The router startup contract initializes a projection, marks it with a sentinel,
constructs the router again, and verifies that the existing projection was not
rebuilt from source rows.
