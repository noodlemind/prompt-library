# Improvements & Status

## Version 2.1.0 Updates

### ✅ Fixed Issues

1. **SubRequest Model Property** (CRITICAL)
   - Added `model: request.model` to subRequest object
   - Fixes: Agent handoffs now properly pass model selection

2. **review.prompt.md Rewrite** (CRITICAL)
   - Removed Claude Code-specific syntax (XML tags, Task() calls, worktree instructions)
   - Reduced from 410 lines to 255 lines
   - Now uses VS Code-compatible patterns with handoffs in YAML frontmatter

3. **Conversation History** (HIGH PRIORITY)
   - Implemented full conversation history support
   - Agents now maintain context across multiple turns
   - Properly handles both ChatRequestTurn and ChatResponseTurn

4. **Token Limit Checking** (HIGH PRIORITY)
   - Added pre-flight token estimation
   - Prevents requests that exceed model.maxInputTokens
   - Provides clear error message to users

5. **Enhanced Error Handling** (HIGH PRIORITY)
   - Specific handling for `LanguageModelError` types
   - Different messages for NotFound, NoPermissions, Blocked errors
   - Better user guidance for resolution

6. **OutputChannel Logging** (MEDIUM PRIORITY)
   - Replaced all console.log with VS Code OutputChannel
   - Structured logging in "Compounding Engineering" output panel
   - Better debugging experience for users

### Architecture

**How It Works:**
- Extension activates and loads agents/prompts from `.github/` directory
- Each agent/prompt is registered as a chat participant
- When invoked, the handler uses `request.model` (user's selection)
- Conversation history is maintained automatically
- Handoffs work through YAML frontmatter configuration

**Key Files:**
- `extension.js` - Activation, registration, OutputChannel
- `src/agentParser.js` - YAML/markdown parsing
- `src/chatHandlers.js` - Request handling, streaming, history, error handling
- `.github/agents/*.agent.md` - 17 agent definitions
- `.github/prompts/*.prompt.md` - 6 workflow prompts

### Tools

**Tool Availability:**
- Tools (`search`, `githubRepo`, `fetch`) are automatically provided by VS Code in agent mode
- The `tools` field in YAML is documentation only
- No manual tool registration needed

### Model Selection

**Current Behavior:**
- Uses `request.model` to respect user's choice from chat UI
- Users can select: Auto, GPT-4, GPT-4o, GPT-5-Codex, Claude Sonnet 4, Claude Sonnet 4.5
- "Auto" lets VS Code intelligently choose the best model

## Known Limitations

1. **No Custom Icons**: Currently using ThemeIcon defaults ('robot' for agents, 'layers' for prompts)
2. **No User Configuration**: Settings like max tokens, temperature not exposed
3. **No Telemetry**: Usage tracking for Mission Control not implemented
4. **No MCP Integration**: Model Context Protocol servers not yet supported

## Future Enhancements

See [ROADMAP.md](ROADMAP.md) for planned features.

## Version History

- **v2.1.0** (Current): Critical fixes, conversation history, enhanced error handling
- **v2.0.0**: Initial release with 17 agents and 6 prompts, model selection fix

---

**Last Updated:** 2025-01-14
