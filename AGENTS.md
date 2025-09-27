# AGENTS Guidelines

This repository contains a Node.js backend service that manages influencer configurations and provides functionality for
Discord and Telegram bot integration, along with exchange API connectivity. The system enables influencer verification,
leaderboard tracking, and user management across multiple platforms.

Follow these instructions when contributing:

1. **Testing**: Run `npm test` after making changes to ensure all Jest tests pass.
2. **Linting**: Check code style with `npx eslint .` and fix any reported issues.
3. **Pull Requests**: Describe your changes clearly and reference related issues if applicable.
4. **Commit Style**: Use short, present-tense commit messages (e.g. "add new signal model").
5. **Knowledge Base**: After implementing changes, update the project's knowledge base documentation to ensure it stays
   synchronized with the codebase.
6. **Code Comments**: Add clear and concise comments to explain complex logic, functionality, and any non-obvious
   implementations. Update existing comments when modifying code.
7. **API Documentation**: Keep the OpenAPI specification (docs/openapi.json) up to date when modifying API endpoints,
   request/response schemas, or security configurations.
8. **Logging**: Implement comprehensive logging using appropriate log levels (error, warn, info, debug) for all critical
   operations, exceptions, and important state changes to aid debugging and monitoring.
9. **Command Help**: Whenever you add, remove, or rename a bot command, update the Telegram and Discord help responses so
   `/help` and `!help` remain accurate.

These guidelines apply to the entire project tree.