You are helping a user initialize their Tauri React template for their specific application. Follow these steps exactly:

## Step 1: Collect Information

Ask the user for:

1. **App Name**: What is the name of their application?
2. **App Description**: What does their app do? (Ask for 1-2 sentences)

## Step 2: Process and Update Files

After receiving their input:

1. **Reword the description** to be coherent and professional
2. **Get GitHub username** using `gh api user --jq .login` or `git config user.name`
3. **Update `package.json`** with proper name and description
4. **Update `src/index.html`** title tag
5. **Update `CLAUDE.md`** to include the title and description in the overview section
6. **Update `README.md`** to replace "Tauri React Template" with their app name and update the description
7. **Update `src-tauri/tauri.conf.json`**:
   - Set `productName` to their app name
   - Set `identifier` to `com.${githubUsername}.${kebab-case-app-name}`
   - Set window `title` to their app name
   - Update bundle `shortDescription` and `longDescription`
   - Update bundle `publisher` and `copyright` with GitHub username
   - Update updater endpoint to use their GitHub username and repo name
8. **Update `src-tauri/Cargo.toml`**:
   - Set package `name` to kebab-case app name
   - Set package `description` to their description
   - Update `authors` with GitHub username
9. **Update `.github/workflows/release.yml`**:
   - Update workflow name to use their app name
   - Update release name and body to use their app name
10. **Create `CLAUDE.local.md`** with the specified content

## Step 3: Run Quality Checks

Execute these commands in order:

1. `bun install`
2. `bun run check:all`

## Step 4: Final Instructions

Explain to the user:

- What you've updated
- They need to add their Tauri updater public key to `tauri.conf.json`
- They need to add `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to GitHub Actions secrets
- How to generate the Tauri updater keypair if needed

Be methodical and update each file completely. Do not skip any steps.
