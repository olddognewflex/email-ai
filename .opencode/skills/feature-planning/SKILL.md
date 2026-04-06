# Feature Planning Skill

When planning a feature for this repository:

1. Read AGENTS.md first.
2. Identify the exact domain module(s) involved.
3. Produce:
   - objective
   - scope
   - files to create/change
   - dependencies needed
   - risks
   - test/verification steps
   - rollback/containment notes if mailbox mutation is involved
4. Prefer incremental implementation.
5. Call out overengineering explicitly.
6. If a feature touches AI output, include Zod validation and confidence/review strategy.
