# Security Policy

## Supported versions

Only the latest release receives fixes. The app auto-updates, so most users are already on it.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub: go to the **Security** tab of this repository and choose **Report a vulnerability**. Include steps to reproduce and the app version. You can expect a first reply within a few days.

## Secrets

This repository never contains credentials. The release token lives only in a local, git-ignored `.env` file (see `.env.example`).
