# Changelog

All notable changes to the "Compounding Engineering" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Comprehensive extension analysis documentation (EXTENSION_ANALYSIS.md)
- Publication readiness guide (PUBLICATION_READINESS.md)
- Enhanced package.json metadata for better discoverability

### Changed
- Improved .vscodeignore to exclude development files

## [2.0.0] - 2025-01-14

### Added
- 17 specialized AI agents as chat participants:
  - `@architecture-strategist` - Analyze architectural decisions and system design
  - `@best-practices-researcher` - Research industry best practices and standards
  - `@code-simplicity-reviewer` - Identify opportunities for code simplification
  - `@compounding-python-reviewer` - Expert Python code review
  - `@compounding-rails-reviewer` - Expert Rails code review
  - `@compounding-typescript-reviewer` - Expert TypeScript code review
  - `@data-integrity-guardian` - Review database migrations and data integrity
  - `@dhh-rails-reviewer` - Rails code review from DHH's perspective
  - `@every-style-editor` - Apply Every's editorial style guide
  - `@feedback-codifier` - Codify review feedback into standards
  - `@framework-docs-researcher` - Research framework documentation
  - `@git-history-analyzer` - Analyze git history and code evolution
  - `@pattern-recognition-specialist` - Identify patterns and anti-patterns
  - `@performance-oracle` - Analyze performance and scalability
  - `@pr-comment-resolver` - Address PR comments systematically
  - `@repo-research-analyst` - Analyze repository structure and conventions
  - `@security-sentinel` - Perform security audits and vulnerability scanning

- 6 workflow prompts for common engineering tasks:
  - `@review` with `/code` command - Comprehensive multi-agent code review
  - `@plan` with `/issue` command - Transform feature descriptions into well-structured issues
  - `@triage` with `/issues` command - Analyze and prioritize GitHub issues
  - `@work` with `/on` command - Execute complex tasks with systematic planning
  - `@generate-command` - Create custom workflow command templates
  - `@resolve-todo` with `/parallel` command - Resolve multiple TODOs systematically

- Chat Participant API integration with VS Code
- Language Model API integration for GitHub Copilot
- Streaming response handling for better UX
- Conversation history management across multiple turns
- Agent handoff mechanism for multi-perspective analysis
- Cycle detection to prevent infinite handoff loops
- Token limit checking to prevent request failures
- Comprehensive error handling for LanguageModelError
- OutputChannel logging for debugging
- Follow-up suggestion provider

### Changed
- Migrated from Claude Code to VS Code Chat Participant API
- Updated all agents from Claude Code format to VS Code compatible format
- Simplified review.prompt.md (removed Claude Code-specific syntax)

### Fixed
- Model selection in agent handoffs (now properly passes request.model)
- Conversation history handling for better context awareness

## [1.0.0] - 2024-12-01

### Added
- Initial release for Claude Code
- Basic agent system with .agent.md files
- Prompt templates in .prompt.md format
- GitHub integration via githubRepo tool

---

[Unreleased]: https://github.com/noodlemind/prompt-library/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/noodlemind/prompt-library/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/noodlemind/prompt-library/releases/tag/v1.0.0
