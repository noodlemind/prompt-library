#!/usr/bin/env python3
"""
Convert Claude Code commands to GitHub Copilot prompt format.

This script converts commands from compounding-engineering/commands/*.md
to copilot-compounding-engineering/.github/prompts/*.prompt.md format.
"""

import re
from pathlib import Path

# Command name mapping for better Copilot display names
COMMAND_DISPLAY_NAMES = {
    "generate_command": "Generate Command",
    "plan": "Plan Issue",
    "resolve_todo_parallel": "Resolve Todos in Parallel",
    "review": "Review Code",
    "triage": "Triage Issues",
    "work": "Work on Task",
}

# Tool selection based on command type
COMMAND_TOOLS = {
    "generate_command": ['search'],
    "plan": ['search', 'fetch', 'githubRepo'],
    "resolve_todo_parallel": ['search', 'githubRepo'],
    "review": ['search', 'githubRepo'],
    "triage": ['search', 'githubRepo'],
    "work": ['search', 'githubRepo'],
}

# Agent references for handoffs
COMMAND_AGENTS = {
    "plan": ['repo-research-analyst', 'best-practices-researcher', 'framework-docs-researcher'],
    "review": ['architecture-strategist', 'security-sentinel', 'performance-oracle', 'code-simplicity-reviewer'],
    "work": ['repo-research-analyst', 'best-practices-researcher'],
}


def extract_command_description(content: str) -> str:
    """Extract a concise description from command content."""
    # Look for command_purpose tag
    purpose_match = re.search(r'<command_purpose>\s*(.*?)\s*</command_purpose>', content, flags=re.DOTALL)
    if purpose_match:
        return purpose_match.group(1).strip()

    # Look for Introduction section
    intro_match = re.search(r'## Introduction\s+(.*?)(?:\n##|$)', content, flags=re.DOTALL)
    if intro_match:
        intro_text = intro_match.group(1).strip()
        # Get first sentence
        sentences = intro_text.split('.')
        if sentences:
            return sentences[0].strip()

    # Fallback to first paragraph
    lines = content.split('\n')
    for line in lines:
        line = line.strip()
        if line and not line.startswith('#') and not line.startswith('<'):
            return line[:150]

    return "Execute command workflow"


def create_handoffs(command_name: str) -> list:
    """Create handoff configuration for agents."""
    agents = COMMAND_AGENTS.get(command_name, [])
    handoffs = []

    for agent in agents:
        handoffs.append({
            'label': f'Consult {agent.replace("-", " ").title()}',
            'agent': agent,
            'prompt': f'Analyze this using {agent} expertise',
            'send': False
        })

    return handoffs


def format_copilot_prompt(command_name: str, content: str) -> str:
    """Format content as a GitHub Copilot prompt."""
    display_name = COMMAND_DISPLAY_NAMES.get(command_name, command_name.replace('_', ' ').title())
    tools = COMMAND_TOOLS.get(command_name, ['search'])
    description = extract_command_description(content)

    # Build the frontmatter
    frontmatter = f"""---
name: {display_name}
description: {description}
tools: {tools}
model: Claude Sonnet 4
"""

    # Add handoffs if applicable
    handoffs = create_handoffs(command_name)
    if handoffs:
        frontmatter += "handoffs:\n"
        for handoff in handoffs:
            frontmatter += f"  - label: {handoff['label']}\n"
            frontmatter += f"    agent: {handoff['agent']}\n"
            frontmatter += f"    prompt: {handoff['prompt']}\n"
            frontmatter += f"    send: {str(handoff['send']).lower()}\n"

    frontmatter += "---\n"

    # Clean up the content
    # Remove title (first line starting with #)
    content_lines = content.split('\n')
    if content_lines and content_lines[0].startswith('# '):
        content_lines = content_lines[1:]

    # Remove command_purpose tags
    cleaned_content = '\n'.join(content_lines)
    cleaned_content = re.sub(r'<command_purpose>.*?</command_purpose>', '', cleaned_content, flags=re.DOTALL)

    # Replace $ARGUMENTS placeholder with clear instruction
    cleaned_content = cleaned_content.replace('#$ARGUMENTS', '{user input}')
    cleaned_content = cleaned_content.replace('$ARGUMENTS', '{user input}')

    # Clean up extra whitespace
    cleaned_content = re.sub(r'\n\n\n+', '\n\n', cleaned_content)

    return frontmatter + "\n" + cleaned_content.strip() + "\n"


def convert_command(source_path: Path, dest_path: Path) -> None:
    """Convert a single command file."""
    print(f"Converting {source_path.name}...")

    # Read source file
    content = source_path.read_text()

    # Get command name from filename
    command_name = source_path.stem

    # Format as Copilot prompt
    copilot_content = format_copilot_prompt(command_name, content)

    # Write to destination
    dest_file = dest_path / f"{command_name}.prompt.md"
    dest_file.write_text(copilot_content)
    print(f"  → Created {dest_file.name}")


def main():
    """Convert all commands."""
    # Setup paths
    script_dir = Path(__file__).parent
    source_dir = script_dir.parent.parent / "compounding-engineering" / "commands"
    dest_dir = script_dir / "copilot-compounding-engineering" / ".github" / "prompts"

    # Create destination directory
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Convert all commands
    command_files = sorted(source_dir.glob("*.md"))
    print(f"Found {len(command_files)} commands to convert\n")

    for command_file in command_files:
        try:
            convert_command(command_file, dest_dir)
        except Exception as e:
            print(f"  ✗ Error converting {command_file.name}: {e}")

    print(f"\n✓ Conversion complete! {len(list(dest_dir.glob('*.prompt.md')))} prompts created.")


if __name__ == "__main__":
    main()
