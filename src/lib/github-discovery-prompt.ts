export const CHECK_GITHUB_ISSUES_PROMPT = `Search this repository's existing GitHub issues, pull requests, and discussions for items that the work in this session fully fixes, related items, and similar reports.

Include clickable links when available. Label each result as fully fixed, related, or similar, and show its current state as open or closed. Also show merged for merged pull requests. If there are no matches or you cannot search, say so explicitly.

Do not claim that an item is fixed unless the work fully satisfies it. Do not close or update any item.`
