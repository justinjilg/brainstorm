---
description: "Audit project dependencies for outdated packages, security issues, and unused deps"
model_preference: cheap
max_steps: 5
---

# Dependency Audit

Audit the project's dependencies:

1. Check for outdated packages: `npm outdated`
2. Check for security vulnerabilities: `npm audit --omit=dev`
3. Identify unused dependencies by searching for import statements
4. Report:
   - Critical security issues (fix immediately)
   - Major version updates available
   - Potentially unused dependencies
