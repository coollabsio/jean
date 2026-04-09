use super::types::{CheckCategory, CostTier, NightshiftCheck};

/// Internal check definition with prompt template (not serialized to frontend)
pub struct CheckDefinition {
    pub check: NightshiftCheck,
    pub prompt_template: &'static str,
}

/// All built-in check definitions
pub fn all_checks() -> Vec<CheckDefinition> {
    vec![
        CheckDefinition {
            check: NightshiftCheck {
                id: "lint-fix".into(),
                name: "Lint Fix".into(),
                description: "Fix linting issues and code style violations".into(),
                category: CheckCategory::Lint,
                cost_tier: CostTier::Low,
                cooldown_hours: 24,
                default_enabled: true,
            },
            prompt_template: LINT_FIX_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "dead-code".into(),
                name: "Dead Code Removal".into(),
                description: "Find and remove unused imports, functions, variables, and types"
                    .into(),
                category: CheckCategory::DeadCode,
                cost_tier: CostTier::Medium,
                cooldown_hours: 72,
                default_enabled: true,
            },
            prompt_template: DEAD_CODE_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "doc-drift".into(),
                name: "Documentation Drift".into(),
                description: "Fix stale, missing, or inaccurate documentation and comments".into(),
                category: CheckCategory::Documentation,
                cost_tier: CostTier::Medium,
                cooldown_hours: 48,
                default_enabled: true,
            },
            prompt_template: DOC_DRIFT_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "security-audit".into(),
                name: "Security Audit".into(),
                description:
                    "Find and fix security vulnerabilities (OWASP top 10, hardcoded secrets)"
                        .into(),
                category: CheckCategory::Security,
                cost_tier: CostTier::High,
                cooldown_hours: 168,
                default_enabled: true,
            },
            prompt_template: SECURITY_AUDIT_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "test-gaps".into(),
                name: "Test Coverage Gaps".into(),
                description: "Write tests for untested code paths and missing edge cases".into(),
                category: CheckCategory::Tests,
                cost_tier: CostTier::High,
                cooldown_hours: 72,
                default_enabled: true,
            },
            prompt_template: TEST_GAPS_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "dependency-audit".into(),
                name: "Dependency Audit".into(),
                description: "Update outdated, deprecated, or vulnerable dependencies".into(),
                category: CheckCategory::Dependencies,
                cost_tier: CostTier::Medium,
                cooldown_hours: 168,
                default_enabled: true,
            },
            prompt_template: DEPENDENCY_AUDIT_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "type-safety".into(),
                name: "Type Safety".into(),
                description: "Fix loose types (any, unknown), add missing type annotations".into(),
                category: CheckCategory::TypeSafety,
                cost_tier: CostTier::Medium,
                cooldown_hours: 48,
                default_enabled: true,
            },
            prompt_template: TYPE_SAFETY_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "error-handling".into(),
                name: "Error Handling".into(),
                description: "Improve error handling: missing catches, swallowed errors, poor messages"
                    .into(),
                category: CheckCategory::CodeQuality,
                cost_tier: CostTier::Medium,
                cooldown_hours: 48,
                default_enabled: true,
            },
            prompt_template: ERROR_HANDLING_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "performance-review".into(),
                name: "Performance Review".into(),
                description:
                    "Fix performance issues: N+1 queries, memory leaks, unnecessary re-renders"
                        .into(),
                category: CheckCategory::Performance,
                cost_tier: CostTier::High,
                cooldown_hours: 168,
                default_enabled: false,
            },
            prompt_template: PERFORMANCE_REVIEW_PROMPT,
        },
        CheckDefinition {
            check: NightshiftCheck {
                id: "config-hygiene".into(),
                name: "Config Hygiene".into(),
                description: "Clean up configuration files: unused keys, inconsistencies, env gaps"
                    .into(),
                category: CheckCategory::Configuration,
                cost_tier: CostTier::Low,
                cooldown_hours: 168,
                default_enabled: false,
            },
            prompt_template: CONFIG_HYGIENE_PROMPT,
        },
    ]
}

/// Look up a check definition by ID
pub fn find_check(id: &str) -> Option<CheckDefinition> {
    all_checks().into_iter().find(|c| c.check.id == id)
}

/// Get just the check metadata (without prompt templates) for frontend listing
pub fn all_check_metadata() -> Vec<NightshiftCheck> {
    all_checks().into_iter().map(|c| c.check).collect()
}

/// Get the default prompt template for a check
pub fn get_default_prompt(id: &str) -> Option<&'static str> {
    find_check(id).map(|c| c.prompt_template)
}

// ============================================================================
// Action-oriented prompt templates
// These prompts instruct Claude to directly fix issues, not just report them.
// ============================================================================

const LINT_FIX_PROMPT: &str = r#"You are performing a lint maintenance pass on this codebase.

<task>Find and fix linting issues and code style violations</task>

<instructions>
1. Run the project's linter (eslint, clippy, ruff, etc.) if available
2. Fix all auto-fixable lint violations
3. For issues that can't be auto-fixed, make the code changes manually
4. Focus on: unused variables, missing semicolons, inconsistent formatting, import ordering
5. Run the linter again to verify all fixes pass
</instructions>

<constraints>
- Only fix real lint issues, don't change logic or behavior
- Preserve existing code behavior exactly
- If unsure about a fix, skip it
- Don't reformat entire files, only fix actual violations
</constraints>"#;

const DEAD_CODE_PROMPT: &str = r#"You are performing a dead code cleanup on this codebase.

<task>Find and remove unused code</task>

<instructions>
1. Search for unused imports, functions, variables, types, and constants
2. Remove unreachable code branches (dead else/match arms)
3. Remove commented-out code blocks that are no longer relevant
4. Remove unused dependencies from package manifests
5. Run tests after each removal to verify nothing breaks
</instructions>

<constraints>
- Only remove code that is genuinely unused (not just rarely used)
- Be careful with public API exports — they may be used externally
- Do not remove test utilities or fixture code
- Consider dynamic imports and reflection before removing
- Run the test suite after changes to verify nothing breaks
</constraints>"#;

const DOC_DRIFT_PROMPT: &str = r#"You are performing a documentation maintenance pass on this codebase.

<task>Fix stale, missing, or inaccurate documentation</task>

<instructions>
1. Check if function/method signatures match their doc comments and fix mismatches
2. Add documentation for public APIs that are missing it
3. Remove or update TODO/FIXME comments that reference completed work
4. Update README sections that are outdated relative to the code
</instructions>

<constraints>
- Focus on public interfaces and important internal functions
- Don't add docs for trivial getters/setters
- Only fix genuinely wrong or misleading docs, not minor wording
- Keep documentation concise and useful
</constraints>"#;

const SECURITY_AUDIT_PROMPT: &str = r#"You are performing a security audit on this codebase.

<task>Find and fix security vulnerabilities</task>

<instructions>
1. Check for hardcoded secrets, API keys, tokens, or passwords — move them to env vars
2. Fix SQL injection, XSS, command injection, and path traversal vulnerabilities
3. Replace insecure cryptographic practices (weak hashing, no salt, ECB mode)
4. Add missing input validation at system boundaries
5. Fix insecure file permissions or unsafe deserialization
</instructions>

<constraints>
- Focus on OWASP Top 10 vulnerabilities
- Don't flag internal-only code that doesn't process user input
- Ensure fixes don't break existing functionality
- Run tests after each fix
</constraints>"#;

const TEST_GAPS_PROMPT: &str = r#"You are performing a test coverage improvement pass on this codebase.

<task>Write tests for untested code paths and missing edge cases</task>

<instructions>
1. Find public functions and methods without any test coverage and write tests for them
2. Add missing edge case tests (null, empty, boundary values)
3. Write tests for error paths that are never tested
4. Follow the existing test patterns and conventions in the project
5. Run all tests to ensure they pass
</instructions>

<constraints>
- Focus on business logic, not boilerplate or generated code
- Don't write tests for trivial one-liner functions
- Prioritize by risk: untested error handling > untested happy path
- Match the existing test style and framework
- All new tests must pass
</constraints>"#;

const DEPENDENCY_AUDIT_PROMPT: &str = r#"You are performing a dependency audit on this codebase.

<task>Update outdated and fix problematic dependencies</task>

<instructions>
1. Examine package manifest files (package.json, Cargo.toml, etc.)
2. Update deprecated or unmaintained dependencies to their replacements
3. Remove duplicate dependencies that do the same thing
4. Remove dependencies that are imported but never actually used in code
5. Run tests after updates to verify compatibility
</instructions>

<constraints>
- Only update dependencies with clear issues, not merely old ones
- Don't make major version jumps without verifying compatibility
- Consider if the project pins specific versions intentionally
- Don't remove dev dependencies used only in CI/test environments
- Run the full test suite after any dependency changes
</constraints>"#;

const TYPE_SAFETY_PROMPT: &str = r#"You are performing a type safety improvement pass on this codebase.

<task>Fix loose typing and add missing type annotations</task>

<instructions>
1. Replace uses of `any` type with proper specific types
2. Add missing return type annotations to functions
3. Replace unsafe type assertions/casts with proper type narrowing
4. Fix implicit `any` from untyped library usage by adding type declarations
5. Run the type checker to verify all changes are valid
</instructions>

<constraints>
- Only apply to TypeScript/Rust/typed language files
- Don't replace `any` used intentionally in generic utility functions
- Some libraries genuinely require `any` at boundaries — leave those
- Suggest specific types, not just "remove any"
- All changes must pass the type checker
</constraints>"#;

const ERROR_HANDLING_PROMPT: &str = r#"You are performing an error handling improvement pass on this codebase.

<task>Fix poor error handling patterns</task>

<instructions>
1. Fix empty catch blocks — add proper error handling or logging
2. Fix swallowed errors — ensure they're re-thrown or properly reported
3. Add error handling where functions can throw but callers don't handle it
4. Improve generic error messages to include useful debugging context
5. Add missing error boundaries in UI components where appropriate
</instructions>

<constraints>
- Focus on production-impacting error handling gaps
- Don't change intentional error suppression (with comments explaining why)
- Respect the error handling strategy of the framework being used
- Make specific improvements, not just wrapping everything in try/catch
- Run tests to verify error paths work correctly
</constraints>"#;

const PERFORMANCE_REVIEW_PROMPT: &str = r#"You are performing a performance optimization pass on this codebase.

<task>Find and fix performance issues</task>

<instructions>
1. Fix N+1 query patterns in database access
2. Add memoization for expensive computations (React.memo, useMemo, etc.)
3. Convert synchronous blocking operations to async where appropriate
4. Fix memory leaks (event listeners not cleaned up, growing caches)
5. Remove redundant computation and unnecessary re-renders
</instructions>

<constraints>
- Only fix issues with measurable impact, not micro-optimizations
- Consider the scale at which the application operates
- Don't optimize rarely-executed code paths
- Run tests and verify the application still works correctly after changes
</constraints>"#;

const CONFIG_HYGIENE_PROMPT: &str = r#"You are performing a configuration cleanup pass on this codebase.

<task>Clean up configuration files and environment setup</task>

<instructions>
1. Remove unused configuration keys from config files
2. Add missing environment variables to .env.example that are referenced in code
3. Fix inconsistencies between development and production configs
4. Move hardcoded values to configuration where appropriate
</instructions>

<constraints>
- Don't remove framework-required config keys even if they seem unused
- Be careful with environment-specific overrides
- Some config is intentionally different between environments
- Focus on genuinely problematic configurations
</constraints>"#;
