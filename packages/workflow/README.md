# @brainstorm/workflow

State machine workflow engine with context filtering and confidence-based escalation.

## Key Exports

- `WorkflowEngine` — Execute multi-step workflows
- Preset workflows: debug, refactor, feature, review

## Usage

Workflows define a sequence of steps, each with a prompt, tool restrictions, and success criteria. The engine manages state transitions and can escalate to a more capable model when confidence is low.
