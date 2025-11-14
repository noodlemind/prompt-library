# Roadmap

## Future Features & Enhancements

### Phase 2: UX & Polish

#### Custom Icons
- Replace ThemeIcon defaults with custom SVG icons
- Different icons for different agent types:
  - Security agents: shield icon
  - Performance agents: pulse icon
  - Architecture agents: organization icon
  - Code quality agents: check icon

#### User Configuration
Add settings in package.json:
```json
{
  "compoundingEngineering.enabledAgents": ["*"],
  "compoundingEngineering.maxTokens": 4000,
  "compoundingEngineering.temperature": 0.7,
  "compoundingEngineering.enableTelemetry": true
}
```

#### Command Routing
- Use `request.command` to branch behavior
- Different handling for `/review-code` vs `@review`
- Command-specific logic and parameters

### Phase 3: Advanced Features

#### Mission Control Telemetry
Integration with VS Code telemetry for usage tracking:
- Agent invocation counts
- Success/error rates
- Popular workflows
- Performance metrics

#### MCP Integration
Model Context Protocol support:
- Connect to MCP servers for extended capabilities
- Database queries
- API integrations
- Custom tools

#### Multi-Model Support
Per-agent model preferences:
- Allow agents to specify preferred models
- Fallback chains for model unavailability
- Cost optimization strategies

#### Plan Mode Integration
- Integrate with VS Code's Plan Mode
- Ask clarifying questions before execution
- Build step-by-step plans
- Track plan execution progress

### Phase 4: Testing & Quality

#### Testing Suite
- Unit tests for agent parsing
- Integration tests for chat handlers
- Mock VS Code API for testing
- CI/CD pipeline setup

#### Performance Optimization
- Lazy loading of agents
- Faster extension activation
- Reduced memory footprint
- Bundle size optimization with esbuild

### Community Features

#### Plugin System
- Allow users to add custom agents without modifying extension
- Agent marketplace for sharing
- Community-contributed agents

#### Prompt Templates
- Pre-built workflow templates
- Customizable prompt library
- Share successful patterns

### Documentation

#### User Guides
- Getting started tutorials
- Best practices guide
- Troubleshooting FAQ
- Video demonstrations

#### Developer Documentation
- Agent development guide
- Contribution guidelines
- Architecture deep-dive
- API reference

## Version Planning

### v2.2.0 (Q1 2025)
- Custom icons
- User configuration
- Command routing

### v2.3.0 (Q2 2025)
- Telemetry integration
- MCP support (basic)
- Multi-model preferences

### v2.4.0 (Q3 2025)
- Plan Mode integration
- Testing suite
- Performance optimizations

### v3.0.0 (Q4 2025)
- Plugin system
- Agent marketplace
- Community features

## Contributing

Ideas for future enhancements? Open an issue or submit a PR!

---

**Last Updated:** 2025-01-14
