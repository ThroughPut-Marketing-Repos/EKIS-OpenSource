# EKIS Volume Verification Bot Overview

The EKIS project is a lightweight Node.js service that helps community managers verify whether a trading account
(measured by UID) has met a configured volume threshold. Configuration, exchange credentials, and verification history
live in a SQL database that is accessed through Sequelize. The application bundles three optional interfaces:

- **Discord bot** &ndash; responds to `!verify` commands inside a guild or direct message.
- **Telegram bot** &ndash; guides users through `/start`, exchange selection, and UID submission before issuing invite links.
- **HTTP API** &ndash; exposes REST endpoints that external automations can call.

Each interface uses the same verification core so administrators only need to maintain a single configuration profile
that can be edited from the database or a JSON file. Logging is powered by Winston and is shared across every module for
consistent observability.

## Additional resources

- [README](../../README.md) &mdash; comprehensive setup, deployment, and extension guidance plus support contacts for
  custom development requests.
- [Configuration](configuration.md) &mdash; schema reference covering environment variables and JSON options.
- [HTTP API](http-api.md) &mdash; endpoint summary with links to the OpenAPI specification.
