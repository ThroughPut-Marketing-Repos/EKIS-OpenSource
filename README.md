# EKIS Volume Verification Bot

EKIS is a lightweight Node.js platform that verifies whether a trader has met a configured volume requirement across
multiple exchanges. Communities can use the bots to gate access, grant rewards, or automate onboarding flows without
sharing credentials. This README centralises the information required to set up, operate, and extend the service.

## Key capabilities

- **Unified verification core** &mdash; a single module powers Discord, Telegram, and HTTP workflows to ensure consistent
  results regardless of the interface.
- **Flexible data sources** &mdash; plug in exchange REST APIs, mock providers, or database-backed integrations without
  rewriting the runtime.
- **Multi-channel support** &mdash; respond to verification requests through Discord commands, Telegram interactions, or
  REST automations.
- **Observability-first logging** &mdash; Winston logging with timestamps and colourised levels keeps operations easy to
  follow.

## Architecture overview

```
┌───────────────────┐      ┌──────────────────────────┐
│ Discord Bot       │      │ Telegram Bot             │
│ (discord.js)      │      │ (grammy)                 │
└─────────┬─────────┘      └──────────┬──────────────┘
          │                           │
          ▼                           ▼
     ┌────────────────────────────────────────┐
     │ Verification Service                   │
     │ • Configuration loader                 │
     │ • Volume verifier                      │
     │ • Provider integrations                │
     └───────────┬────────────────────────────┘
                 │
                 ▼
          ┌─────────────────┐
          │ Exchange APIs   │
          │ or Mock Sources │
          └─────────────────┘
```

Configuration lives in `config.json` or environment variables, while persistence is handled via Sequelize-backed SQL
datastores when enabled. Each interface loads the shared verification core so that rule changes only need to be made
once.

## Prerequisites

- Node.js 18+
- npm 9+
- Access tokens for any channels you want to activate (Discord bot token, Telegram bot token)
- Exchange API credentials or mock endpoints for volume lookups

## Project structure

```
.
├── src/                # Application source (bots, services, utilities)
├── docs/               # Knowledge base and API specification
├── scripts/            # Operational and developer scripts
├── tests/              # Jest test suites
├── config.json         # Example configuration file
├── nodemon.json        # Local development watcher config
└── README.md           # You are here
```

## Installation

1. **Clone the repository**

   ```bash
   git clone <repo-url>
   cd ekisbot
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

## Configuration

EKIS can be configured through `config.json`, environment variables, or a mix of both. The key sections include:

- `discord` &mdash; enables the Discord bot and supplies the guilds, command prefixes, and bot token.
- `telegram` &mdash; toggles the Telegram bot and defines command flows, welcome messages, and the bot token.
- `http` &mdash; controls the HTTP API, port, and security middleware.
- `translation` &mdash; sets the locale and fallback language for user-facing messages.
- `exchanges` &mdash; lists each exchange provider with API credentials and default thresholds.
- `database` &mdash; optional SQL storage for persistence and auditing.

See the [Configuration guide](docs/knowledge_base/configuration.md) for the full schema and examples. When running in
production, prefer environment variables to keep secrets out of version control.

### Environment variables

All configuration keys support environment overrides using upper-case and underscore naming, e.g. `DISCORD_TOKEN` or
`HTTP_PORT`. Review `config.json` for the expected keys and types.

## Localisation

EKIS supports multi-language user-facing responses through a flexible translation system:

- **Locale files** &mdash; JSON translation files are stored in `src/i18n/locales/` (e.g., `en.json`, `fr.json`).
- **Configuration** &mdash; set your preferred `locale` and `fallbackLocale` in the `translation` section of `config.json`.
- **Environment override** &mdash; use `TRANSLATION_LOCALE` and `TRANSLATION_FALLBACK_LOCALE` to adjust the language without modifying files.

The system automatically falls back to English if a translation key is missing in the selected locale. To add a new language:

1. Create a new locale file in `src/i18n/locales/` (e.g., `es.json`).
2. Copy the structure from `en.json` and translate all message keys.
3. Update your `config.json` to set `translation.locale` to your new locale code.

All user-facing strings in Discord embeds, Telegram messages, and HTTP API responses use the translation system, making it
simple to localise the entire bot without code changes.

## Running the service

Start the application with:

```bash
npm start
```

The process loads the configuration, initialises enabled interfaces, and begins logging verification activity to STDOUT.
For local development with live reload, use `npm run dev`.

## Bot commands

### Discord (`discord.js`)

```text
!verify <uid> [exchangeId] [minimumVolume]
```

- Looks up the configured exchange (or default) for the supplied UID.
- Returns the detected volume, the threshold used, and whether verification passed.

### Telegram (`grammy`)

```text
/verify <uid> [exchangeId] [minimumVolume]
```

- Guides the user through UID submission and optional exchange selection.
- Replies with the verification outcome using the same logic as Discord.

### HTTP API

When `http.enabled` is `true`, the service exposes REST endpoints for automations. Reference
[`docs/openapi.json`](docs/openapi.json) and the [HTTP API knowledge base](docs/knowledge_base/http-api.md) for detailed
request/response schemas.

## Testing and quality

- **Unit tests** &mdash; run `npm test` to execute Jest suites located in `tests/`.
- **Linting** &mdash; run `npm run lint` (or `npx eslint .`) to enforce the project's ESLint configuration.
- **Type safety** &mdash; although the project is JavaScript-first, keep an eye on runtime type checks in the services and
  update them when contracts change.

## Logging and monitoring

All modules should use the shared Winston logger (`src/utils/logger.js`) for consistent, timestamped log output. Leverage
appropriate levels (`error`, `warn`, `info`, `debug`) to aid troubleshooting in production deployments.

## Deployment tips

- Use process managers such as PM2 or systemd for long-running services.
- Configure health checks against the HTTP API when enabled.
- Rotate API credentials regularly and enforce least privilege on exchange accounts.
- Monitor logs for repeated verification failures that might indicate credential issues.

## Extending EKIS

1. **Add a new exchange provider** by implementing a module in `src/exchanges/` that exposes a `getVolume(uid, options)`
   method.
2. **Create custom commands** by updating the Discord and Telegram command handlers and keeping the `/help` and `!help`
   responses in sync.
3. **Integrate additional databases** via new Sequelize models or alternative data layers.

When extending APIs or bots, remember to document the behaviour in the knowledge base and update `docs/openapi.json` if
API contracts change.

## Support and custom development

If you need bespoke features, integrations, or hands-on assistance with deployment, reach out via:

- **Email:** [taha@throughput.agency](mailto:taha@throughput.agency)
- **Instagram:** [@PHE0NlX](https://instagram.com/PHE0NlX)
- **Discord:** `pho.enix`

We are happy to discuss tailored solutions, integrations, and onboarding support.

## Additional documentation

Comprehensive guides live under `docs/knowledge_base/`:

- [Overview](docs/knowledge_base/overview.md)
- [Configuration](docs/knowledge_base/configuration.md)
- [Discord Bot](docs/knowledge_base/discord.md)
- [Telegram Bot](docs/knowledge_base/telegram.md)
- [HTTP API](docs/knowledge_base/http-api.md)
- [Volume Verifier](docs/knowledge_base/volume-verifier.md)
- [Trading Volume Monitor](docs/knowledge_base/trading-volume-monitor.md)

Keep these documents in sync with the codebase whenever behaviour changes, and remember to update translation files when
adding or modifying user-facing messages.
