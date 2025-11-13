#!/usr/bin/env python3
"""
Convert Claude Code agents to GitHub Copilot agent format.

This script converts agents from compounding-engineering/agents/*.md
to copilot-compounding-engineering/.github/agents/*.agent.md format.
"""

import re
from pathlib import Path
from typing import Dict, Tuple

# Agent name mapping for better Copilot display names
AGENT_DISPLAY_NAMES = {
    "architecture-strategist": "Architecture Strategist",
    "best-practices-researcher": "Best Practices Researcher",
    "code-simplicity-reviewer": "Code Simplicity Reviewer",
    "data-integrity-guardian": "Data Integrity Guardian",
    "dhh-rails-reviewer": "DHH Rails Reviewer",
    "every-style-editor": "Every Style Editor",
    "feedback-codifier": "Feedback Codifier",
    "framework-docs-researcher": "Framework Docs Researcher",
    "git-history-analyzer": "Git History Analyzer",
    "compounding-python-reviewer": "Compounding Python Reviewer",
    "compounding-rails-reviewer": "Compounding Rails Reviewer",
    "compounding-typescript-reviewer": "Compounding TypeScript Reviewer",
    "pattern-recognition-specialist": "Pattern Recognition Specialist",
    "performance-oracle": "Performance Oracle",
    "pr-comment-resolver": "PR Comment Resolver",
    "repo-research-analyst": "Repo Research Analyst",
    "security-sentinel": "Security Sentinel",
}

# Tool selection based on agent type
AGENT_TOOLS = {
    "architecture-strategist": ['search', 'githubRepo'],
    "best-practices-researcher": ['search', 'fetch'],
    "code-simplicity-reviewer": ['search', 'githubRepo'],
    "data-integrity-guardian": ['search', 'githubRepo'],
    "dhh-rails-reviewer": ['search', 'githubRepo'],
    "every-style-editor": ['search'],
    "feedback-codifier": ['search', 'githubRepo'],
    "framework-docs-researcher": ['search', 'fetch'],
    "git-history-analyzer": ['search', 'githubRepo'],
    "compounding-python-reviewer": ['search', 'githubRepo'],
    "compounding-rails-reviewer": ['search', 'githubRepo'],
    "compounding-typescript-reviewer": ['search', 'githubRepo'],
    "pattern-recognition-specialist": ['search', 'githubRepo'],
    "performance-oracle": ['search', 'githubRepo'],
    "pr-comment-resolver": ['search', 'githubRepo'],
    "repo-research-analyst": ['search', 'githubRepo', 'fetch'],
    "security-sentinel": ['search', 'githubRepo'],
}


def parse_frontmatter(content: str) -> Tuple[Dict[str, str], str]:
    """Extract YAML frontmatter and body from markdown content."""
    if not content.startswith('---\n'):
        return {}, content

    # Find the closing ---
    parts = content.split('---\n', 2)
    if len(parts) < 3:
        return {}, content

    frontmatter_text = parts[1]
    body = parts[2]

    # Parse frontmatter
    frontmatter = {}
    for line in frontmatter_text.split('\n'):
        if ':' in line:
            key, value = line.split(':', 1)
            frontmatter[key.strip()] = value.strip()

    return frontmatter, body


def extract_short_description(description: str) -> str:
    """Extract a concise description for the agent."""
    # Remove example tags and commentary
    description = re.sub(r'<example>.*?</example>', '', description, flags=re.DOTALL)
    description = re.sub(r'<commentary>.*?</commentary>', '', description, flags=re.DOTALL)

    # Get first sentence
    sentences = description.split('.')
    if sentences:
        first_sentence = sentences[0].strip()
        # Limit to reasonable length
        if len(first_sentence) > 150:
            return first_sentence[:147] + '...'
        return first_sentence

    return description[:150]


def extract_examples(description: str) -> list:
    """Extract examples from the description."""
    examples = []
    example_pattern = r'<example>(.*?)</example>'
    matches = re.findall(example_pattern, description, flags=re.DOTALL)

    for match in matches:
        # Parse the example content
        context_match = re.search(r'Context: (.*?)(?:user:|$)', match, flags=re.DOTALL)
        user_match = re.search(r'user: "(.*?)"', match, flags=re.DOTALL)
        assistant_match = re.search(r'assistant: "(.*?)"', match, flags=re.DOTALL)

        if context_match and user_match:
            context = context_match.group(1).strip()
            user_text = user_match.group(1).strip()
            assistant_text = assistant_match.group(1).strip() if assistant_match else ""

            examples.append({
                'context': context,
                'user': user_text,
                'assistant': assistant_text
            })

    return examples


def format_copilot_agent(agent_name: str, frontmatter: Dict[str, str], body: str) -> str:
    """Format content as a GitHub Copilot agent."""
    display_name = AGENT_DISPLAY_NAMES.get(agent_name, agent_name.replace('-', ' ').title())
    tools = AGENT_TOOLS.get(agent_name, ['search'])

    # Extract short description
    full_description = frontmatter.get('description', '')
    short_description = extract_short_description(full_description)

    # Extract examples
    examples = extract_examples(full_description)

    # Build the new frontmatter
    new_frontmatter = f"""---
name: {display_name}
description: {short_description}
tools: {tools}
model: Claude Sonnet 4
---
"""

    # Build the agent body
    agent_body = body.strip()

    # Add "When to Use This Agent" section if we have the full description
    if full_description and not agent_body.startswith('## When to Use'):
        when_to_use = f"\n## When to Use This Agent\n\n{full_description.split('<example>')[0].strip()}\n"
        agent_body = when_to_use + agent_body

    # Add examples section if we have examples
    if examples and '## Examples' not in agent_body:
        examples_section = "\n## Examples\n\n"
        for i, example in enumerate(examples, 1):
            examples_section += f"**Example {i}:** {example['context']}\n"
            examples_section += f"- User: \"{example['user']}\"\n"
            if example['assistant']:
                examples_section += f"- Response: {example['assistant']}\n"
            examples_section += "\n"

        # Insert examples after the "When to Use" section or at the beginning
        if '## When to Use' in agent_body:
            parts = agent_body.split('## When to Use', 1)
            when_section_end = parts[1].find('\n##')
            if when_section_end != -1:
                agent_body = (parts[0] + '## When to Use' +
                            parts[1][:when_section_end] +
                            examples_section +
                            parts[1][when_section_end:])
            else:
                agent_body = agent_body + examples_section
        else:
            agent_body = examples_section + agent_body

    return new_frontmatter + "\n" + agent_body + "\n"


def convert_agent(source_path: Path, dest_path: Path) -> None:
    """Convert a single agent file."""
    print(f"Converting {source_path.name}...")

    # Read source file
    content = source_path.read_text()

    # Parse frontmatter and body
    frontmatter, body = parse_frontmatter(content)

    # Get agent name from filename
    agent_name = source_path.stem

    # Format as Copilot agent
    copilot_content = format_copilot_agent(agent_name, frontmatter, body)

    # Write to destination
    dest_file = dest_path / f"{agent_name}.agent.md"
    dest_file.write_text(copilot_content)
    print(f"  → Created {dest_file.name}")


def main():
    """Convert all agents."""
    # Setup paths
    script_dir = Path(__file__).parent
    source_dir = script_dir.parent.parent / "compounding-engineering" / "agents"
    dest_dir = script_dir / "copilot-compounding-engineering" / ".github" / "agents"

    # Create destination directory
    dest_dir.mkdir(parents=True, exist_ok=True)

    # Convert all agents
    agent_files = sorted(source_dir.glob("*.md"))
    print(f"Found {len(agent_files)} agents to convert\n")

    for agent_file in agent_files:
        try:
            convert_agent(agent_file, dest_dir)
        except Exception as e:
            print(f"  ✗ Error converting {agent_file.name}: {e}")

    print(f"\n✓ Conversion complete! {len(list(dest_dir.glob('*.agent.md')))} agents created.")


if __name__ == "__main__":
    main()
