# Safe AI Feature Skill

When implementing any AI-powered feature:

1. Read AGENTS.md first.
2. Prefer deterministic rules before LLM invocation.
3. Require structured output.
4. Validate all model output with Zod.
5. Add fallback behavior for invalid output.
6. Add confidence handling and review thresholds.
7. Do not allow destructive automatic actions based solely on model output.
8. Include audit logging and explainability wherever actions may follow classification.
