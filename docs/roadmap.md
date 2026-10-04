# Roadmap

This document promises **no date**. It lists what is missing, with, for each
entry, the precise place in the code concerned and what it would take to lift it.
An entry is here because it was observed — not because it would be "nice to
have".

The limits *already* observable by a user are described, with their
measurements, in the "Known limits" section of the [README](../README.md). This
document is its counterpart: what we would do to make them disappear.

## What blocks real use

### `MASTER_KEY` rotation

The encryption format is `version:iv:authTag:ciphertext`: the `version` field
exists **to allow** a rotation. The rotation code itself is not written. Today,
changing `MASTER_KEY` makes unreadable the SSH credentials, secret values, the
AI API key, notification channel secrets, probe webhook URLs, the GitHub App's
key, forge tokens, backup destination keys — and **every backup already made**,
whose format (`PUPB`, version 1) has no room for a second key.

## Coverage gaps

### Keycloak roles do not come through as is

Single sign-on reads groups in the **ID token**, through a single field
(`sso.groupsClaim`, read by `claimValues()` in `packages/core/src/sso.ts`). But
Keycloak only puts its realm roles (`realm_access.roles`) and client roles
(`resource_access.<client>.roles`) in the **access token**: neither the ID token
nor `userinfo` carries them by default. Today, you therefore have to go through
groups ("Group Membership" mapper) — or tick "Add to ID token" on the roles
mapper.

What it would take: also read the access token (verified against the same
keys), accept several fields at once (groups **and** roles), and offer
`realm_access.roles` as a choice on the screen rather than a path to type.

## Abstractions declared but with a single implementation

### BunkerWeb in a cluster, and a found BunkerWeb

`BunkerWebProvider` drives a BunkerWeb Docker container (1.6 series), through
its API — installed by Pupitre or found with its API enabled. Left to do: its
ingress controller for K3s (today, a K3s machine links to the BunkerWeb of a
Docker machine), a BunkerWeb installed as a system package, and setting up the
certificates of a found BunkerWeb — Pupitre does not request certificates from
it as long as no email is set for it.

### Nginx Proxy Manager, beyond the connection

Pupitre connects to a running Nginx Proxy Manager, outside the targets, and hands
it hosts through its API. Left to do: installing it on a machine itself, having
it request a wildcard through a DNS challenge (today, a wildcard already present
in NPM is reused), and recording NPM's arrival address on a machine without
python3 or perl.

### No wildcard certificate

A `*.example.com` requires the DNS-01 challenge, hence access to the domain's
DNS API. Today, only HTTP-01 is set up by Pupitre.

## What is not planned, and why

- **An image registry.** A decision frozen in [`CLAUDE.md`](../CLAUDE.md): the
  build happens on the target machine. Reopening this decision would change the
  shape of both drivers.
- **Ansible, or Linux cron.** Same document, same reasons: remote execution goes
  through `node-ssh`, scheduling through BullMQ's repeatable jobs.

## A bilingual product, an English codebase

The product speaks French or English, as set for the instance (**Settings →
Regional settings**): screens, deployment logs, driver errors, schema
complaints, notifications. Every text a user reads lives in a dictionary, and
two test guards refuse French hard-coded in the panel, in `@pupitre/core`, in
the worker and in the database package.

The code is moving to English. The documentation is in English; part of the
code comments, the test titles, the Pino logs and the AI system prompt are still
in French, and are being translated. The guard's `NOT_PRODUCT` allowlist
(`apps/web/test/product-messages.test.mjs`) shrinks as they are.

Still in French by default on a new instance: the locale (`fr-FR`), the
tagline, and the labels of the seeded roles — values an administrator can
change.
