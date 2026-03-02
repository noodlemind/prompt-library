#!/bin/bash

# Compounding Engineering for GitHub Copilot - Installation Script
# This script helps you install the agents and prompts in your preferred location

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  Compounding Engineering for GitHub Copilot${NC}"
echo -e "${BLUE}  Installation Script${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v code &> /dev/null; then
    echo -e "${RED}✗ VS Code not found. Please install VS Code first.${NC}"
    exit 1
fi
echo -e "${GREEN}✓ VS Code found${NC}"

echo ""
echo -e "${YELLOW}Installation Options:${NC}"
echo ""
echo "1) Project-level (install to a specific project)"
echo "2) Global (install for all VS Code projects)"
echo "3) Both (install globally and to a project)"
echo "4) Cancel"
echo ""
read -p "Choose an option (1-4): " choice

case $choice in
    1)
        # Project-level installation
        echo ""
        read -p "Enter the path to your project: " project_path

        if [ ! -d "$project_path" ]; then
            echo -e "${RED}✗ Directory not found: $project_path${NC}"
            exit 1
        fi

        project_path=$(cd "$project_path" && pwd)
        echo -e "${YELLOW}Installing to: $project_path/.github${NC}"

        # Create .github directory if it doesn't exist
        mkdir -p "$project_path/.github"

        # Copy agents
        echo -e "${YELLOW}Copying agents...${NC}"
        cp -r "$SCRIPT_DIR/.github/agents" "$project_path/.github/"
        echo -e "${GREEN}✓ Agents installed${NC}"

        # Copy prompts
        echo -e "${YELLOW}Copying prompts...${NC}"
        cp -r "$SCRIPT_DIR/.github/prompts" "$project_path/.github/"
        echo -e "${GREEN}✓ Prompts installed${NC}"

        echo ""
        echo -e "${GREEN}✓ Installation complete!${NC}"
        echo ""
        echo -e "${YELLOW}Next steps:${NC}"
        echo "1. Restart VS Code"
        echo "2. Open your project: $project_path"
        echo "3. Open GitHub Copilot Chat (Cmd/Ctrl + I)"
        echo "4. Type @ to see available agents"
        echo "5. Type / to see available prompts"
        ;;

    2)
        # Global installation
        echo ""
        echo -e "${YELLOW}Installing globally...${NC}"

        # Determine VS Code user directory
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            vscode_dir="$HOME/.vscode"
        elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
            # Windows
            vscode_dir="$USERPROFILE/.vscode"
        else
            # Linux
            vscode_dir="$HOME/.config/Code/User"
        fi

        echo -e "${YELLOW}Installing to: $vscode_dir${NC}"

        # Create agents directory
        mkdir -p "$vscode_dir/agents"

        # Copy agents
        echo -e "${YELLOW}Copying agents...${NC}"
        cp -r "$SCRIPT_DIR/.github/agents/"* "$vscode_dir/agents/"
        echo -e "${GREEN}✓ Agents installed${NC}"

        # Note: Prompts are typically project-specific
        echo ""
        echo -e "${YELLOW}Note: Prompts are project-specific and weren't installed globally.${NC}"
        echo -e "${YELLOW}To use prompts, install them at the project level.${NC}"

        echo ""
        echo -e "${GREEN}✓ Installation complete!${NC}"
        echo ""
        echo -e "${YELLOW}Next steps:${NC}"
        echo "1. Restart VS Code"
        echo "2. Open any project"
        echo "3. Open GitHub Copilot Chat (Cmd/Ctrl + I)"
        echo "4. Type @ to see available agents"
        ;;

    3)
        # Both installations
        echo ""
        read -p "Enter the path to your project: " project_path

        if [ ! -d "$project_path" ]; then
            echo -e "${RED}✗ Directory not found: $project_path${NC}"
            exit 1
        fi

        project_path=$(cd "$project_path" && pwd)

        # Project installation
        echo -e "${YELLOW}Installing to project: $project_path/.github${NC}"
        mkdir -p "$project_path/.github"
        cp -r "$SCRIPT_DIR/.github/agents" "$project_path/.github/"
        cp -r "$SCRIPT_DIR/.github/prompts" "$project_path/.github/"
        echo -e "${GREEN}✓ Project installation complete${NC}"

        # Global installation
        if [[ "$OSTYPE" == "darwin"* ]]; then
            vscode_dir="$HOME/.vscode"
        elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
            vscode_dir="$USERPROFILE/.vscode"
        else
            vscode_dir="$HOME/.config/Code/User"
        fi

        echo -e "${YELLOW}Installing globally to: $vscode_dir${NC}"
        mkdir -p "$vscode_dir/agents"
        cp -r "$SCRIPT_DIR/.github/agents/"* "$vscode_dir/agents/"
        echo -e "${GREEN}✓ Global installation complete${NC}"

        echo ""
        echo -e "${GREEN}✓ Installation complete!${NC}"
        echo ""
        echo -e "${YELLOW}Next steps:${NC}"
        echo "1. Restart VS Code"
        echo "2. Open your project: $project_path"
        echo "3. Open GitHub Copilot Chat (Cmd/Ctrl + I)"
        echo "4. Type @ to see available agents"
        echo "5. Type / to see available prompts"
        ;;

    4)
        echo ""
        echo -e "${YELLOW}Installation cancelled.${NC}"
        exit 0
        ;;

    *)
        echo -e "${RED}Invalid option. Installation cancelled.${NC}"
        exit 1
        ;;
esac

echo ""
echo -e "${BLUE}================================================${NC}"
echo -e "${GREEN}  Installation Summary${NC}"
echo -e "${BLUE}================================================${NC}"
echo ""
echo -e "Installed agents: ${GREEN}17${NC}"
echo -e "  - Architecture Strategist"
echo -e "  - Best Practices Researcher"
echo -e "  - Code Simplicity Reviewer"
echo -e "  - Data Integrity Guardian"
echo -e "  - DHH Rails Reviewer"
echo -e "  - Every Style Editor"
echo -e "  - Feedback Codifier"
echo -e "  - Framework Docs Researcher"
echo -e "  - Git History Analyzer"
echo -e "  - Compounding Python Reviewer"
echo -e "  - Compounding Rails Reviewer"
echo -e "  - Compounding TypeScript Reviewer"
echo -e "  - Pattern Recognition Specialist"
echo -e "  - Performance Oracle"
echo -e "  - PR Comment Resolver"
echo -e "  - Repo Research Analyst"
echo -e "  - Security Sentinel"
echo ""
echo -e "Installed prompts: ${GREEN}6${NC}"
echo -e "  - /generate-command"
echo -e "  - /plan-issue"
echo -e "  - /resolve-todo-parallel"
echo -e "  - /review-code"
echo -e "  - /triage-issues"
echo -e "  - /work-on-task"
echo ""
echo -e "${BLUE}For detailed usage instructions, see:${NC}"
echo -e "  - README.md (comprehensive guide)"
echo -e "  - QUICKSTART.md (quick start guide)"
echo ""
echo -e "${GREEN}Happy engineering! 🚀${NC}"
