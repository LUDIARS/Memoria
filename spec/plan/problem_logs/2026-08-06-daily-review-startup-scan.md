---
title: Daily review discovery delayed Memoria startup
date: 2026-08-06
status: fixed
service: memoria
---

# Daily review discovery delayed Memoria startup

## Symptom

Memoria spent the start of its process lifetime enumerating the workspace and
running Git configuration reads for hundreds of repositories before binding its
HTTP port. During that interval Excubitor had a live process but loopback health
and the UI were unavailable.

## Cause

Memoria owned a daily-review target registry, startup discovery, review file
reader API, and review UI even though review execution and test evidence belong
to Revisor. The startup seed synchronously inspected every candidate clone before
the HTTP server was created.

## Resolution

Daily-review ownership moves to Revisor. Memoria removes:

- startup target and scope discovery;
- the review target database schema and CRUD helpers;
- review APIs and filesystem staleness scans;
- the review navigation, viewer, and target-management UI.

Existing review files are not deleted. Revisor can read and present the retained
history while Memoria starts without workspace-wide Git discovery.
