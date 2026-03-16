#!/usr/bin/env node

import fs from 'fs'
import { execSync } from 'child_process'
import readline from 'readline'

function exec(command, options = {}) {
  try {
    return execSync(command, {
      encoding: 'utf8',
      stdio: options.silent ? 'pipe' : 'inherit',
      ...options,
    })
  } catch (error) {
    throw new Error(`Command failed: ${command}\n${error.message}`)
  }
}

function askQuestion(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function prepareRelease() {
  const version = process.argv[2]

  if (!version || !version.match(/^v?\d+\.\d+\.\d+$/)) {
    console.error('❌ Usage: node scripts/prepare-release.js v1.0.0')
    console.error('   or: bun run prepare-release v1.0.0')
    process.exit(1)
  }

  const cleanVersion = version.replace('v', '')
  const tagVersion = version.startsWith('v') ? version : `v${version}`

  console.log(`🚀 Preparing release ${tagVersion}...\n`)

  try {
    // Check git status
    console.log('🔍 Checking git status...')
    const gitStatus = exec('git status --porcelain', { silent: true })
    if (gitStatus.trim()) {
      console.error(
        '❌ Working directory is not clean. Please commit or stash changes first.'
      )
      console.log('Uncommitted changes:')
      console.log(gitStatus)
      process.exit(1)
    }
    console.log('✅ Working directory is clean')

    // Run all checks first
    console.log('\n🔍 Running pre-release checks...')
    exec('bun run check:all')
    console.log('✅ All checks passed')

    // Update package.json
    console.log('\n📝 Updating package.json...')
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const oldPkgVersion = pkg.version
    pkg.version = cleanVersion
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n')
    console.log(`   ${oldPkgVersion} → ${cleanVersion}`)

    // Update Cargo.toml
    console.log('📝 Updating Cargo.toml...')
    const cargoPath = 'src-tauri/Cargo.toml'
    const cargoToml = fs.readFileSync(cargoPath, 'utf8')
    const oldCargoVersion = cargoToml.match(/version = "([^"]*)"/)
    const updatedCargo = cargoToml.replace(
      /version = "[^"]*"/,
      `version = "${cleanVersion}"`
    )
    fs.writeFileSync(cargoPath, updatedCargo)
    console.log(
      `   ${oldCargoVersion ? oldCargoVersion[1] : 'unknown'} → ${cleanVersion}`
    )

    // Update tauri.conf.json
    console.log('📝 Updating tauri.conf.json...')
    const tauriConfigPath = 'src-tauri/tauri.conf.json'
    const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'))
    const oldTauriVersion = tauriConfig.version
    tauriConfig.version = cleanVersion
    fs.writeFileSync(
      tauriConfigPath,
      JSON.stringify(tauriConfig, null, 2) + '\n'
    )
    console.log(`   ${oldTauriVersion} → ${cleanVersion}`)

    // Run bun install to update lock files
    console.log('\n📦 Updating lock files...')
    exec('bun install', { silent: true })
    console.log('✅ Lock files updated')

    // Verify configurations
    console.log('\n🔍 Verifying configurations...')

    if (!tauriConfig.bundle?.createUpdaterArtifacts) {
      console.warn(
        '⚠️  Warning: createUpdaterArtifacts not enabled in tauri.conf.json'
      )
    } else {
      console.log('✅ Updater artifacts enabled')
    }

    if (!tauriConfig.plugins?.updater?.pubkey) {
      console.warn('⚠️  Warning: Updater public key not configured')
    } else {
      console.log('✅ Updater public key configured')
    }

    // Final check that Rust code compiles
    console.log('\n🔍 Running final compilation check...')
    exec('source ~/.cargo/env && cd src-tauri && cargo check')
    console.log('✅ Rust compilation check passed')

    console.log(`\n🎉 Successfully prepared release ${tagVersion}!`)
    console.log('\n📋 Next steps:')
    console.log(`   1. git add .`)
    console.log(`   2. git commit -m "chore: release ${tagVersion}"`)
    console.log(`   3. git push origin main`)
    console.log(`   4. Go to GitHub > Releases > "Create a new release"`)
    console.log(
      `   5. Create tag ${tagVersion}, write release notes, and publish`
    )
    console.log('\n🚀 After publishing the GitHub Release:')
    console.log('   • GitHub Actions will automatically build all platforms')
    console.log('   • Artifacts will be uploaded to the release')
    console.log('   • Users will receive auto-update notifications')

    const answer = await askQuestion(
      '\n❓ Would you like me to commit and push? (y/N): '
    )

    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      console.log('\n⚡ Executing git commands...')

      console.log('📝 Adding changes...')
      exec('git add .')

      console.log('💾 Creating commit...')
      exec(`git commit -m "chore: release ${tagVersion}"`)

      console.log('📤 Pushing to remote...')
      exec('git push origin main')

      console.log(`\n✅ Changes pushed! Now create the release on GitHub:`)
      console.log(`   → Create tag ${tagVersion} and publish the release`)
      console.log(
        '   → GitHub Actions will build and upload artifacts automatically'
      )
    } else {
      console.log('\n📝 Commands saved for manual execution.')
      console.log("   Run them when you're ready to release.")
    }
  } catch (error) {
    console.error('\n❌ Pre-release preparation failed:', error.message)
    process.exit(1)
  }
}

// Run if this is the main module
prepareRelease()
