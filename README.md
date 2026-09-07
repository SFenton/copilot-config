# Copilot Config

Version-controlled personal GitHub Copilot CLI skills and configuration.

## Skills

- `skills/tandem-research` - Explicit-only GPT-5.6 Sol and Claude Opus 5
  research, cross-critique, evidence adjudication, and Sol-only
  implementation.

## Install

Clone this repository, then link the skill into the personal Copilot skills
directory:

```bash
mkdir -p "$HOME/.copilot/skills"
ln -s "$HOME/repos/copilot-config/skills/tandem-research" \
  "$HOME/.copilot/skills/tandem-research"
```

Back up or remove an existing destination before creating the link. Reload
skills with `/skills reload` in an active Copilot CLI session.
