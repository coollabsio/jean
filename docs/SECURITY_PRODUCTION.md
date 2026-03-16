# Security Production Guide

⚠️ **CRITICAL: This template contains placeholder security configurations that MUST be changed before production deployment.**

## Overview

This guide covers essential security configurations required before deploying your Tauri application to production. The template ships with development-friendly defaults that are **NOT secure** for production use.

## Critical Security Requirements

### 1. Auto-Updater Keys (CRITICAL)

**Status**: ❌ **PLACEHOLDER KEYS - REPLACE BEFORE PRODUCTION**

The template includes placeholder Ed25519 keys in `src-tauri/tauri.conf.json`. These are public and **completely insecure**.

#### Generate Proper Updater Keys

1. **Install Tauri CLI** (if not already installed):

   ```bash
   bun add -g @tauri-apps/cli
   ```

2. **Generate new Ed25519 keypair**:

   ```bash
   tauri signer generate -w ~/.tauri/myapp.key
   ```

3. **Update your configuration**:
   - Copy the **public key** to `src-tauri/tauri.conf.json`:
     ```json
     {
       "plugins": {
         "updater": {
           "pubkey": "YOUR_PUBLIC_KEY_HERE"
         }
       }
     }
     ```
   - Store the **private key** securely for signing releases
   - **Never commit the private key to version control**

4. **Sign your releases**:
   ```bash
   tauri signer sign -k ~/.tauri/myapp.key -f path/to/your/app.tar.gz
   ```

#### Environment Variables (Recommended)

For CI/CD, store keys as environment variables:

```bash
# In your CI environment
export TAURI_SIGNING_PRIVATE_KEY="your-private-key-content"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-key-password"
```

### 2. Application Metadata

**File**: `src-tauri/tauri.conf.json`

Update all placeholder values:

```json
{
  "productName": "Your App Name",
  "version": "1.0.0",
  "identifier": "com.yourcompany.yourapp",
  "bundle": {
    "publisher": "Your Company Name",
    "copyright": "Copyright © 2025 Your Company. All rights reserved."
  }
}
```

### 3. Plugin Permissions Review

**File**: `src-tauri/capabilities/desktop.json`

Review and minimize permissions based on your app's needs:

```json
{
  "permissions": [
    "core:default",
    "fs:read-file", // Only if you need file reading
    "fs:write-file", // Only if you need file writing
    "notification:default" // Only if you need notifications
    // Remove unused permissions
  ]
}
```

**Security Principle**: Grant only the minimum permissions required for your application to function.

### 4. Content Security Policy (CSP)

While less critical for Tauri apps (since React runs in Tauri's webview, not a browser), you may still want to configure CSP for defense in depth:

**File**: `src-tauri/tauri.conf.json`

```json
{
  "security": {
    "csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';"
  }
}
```

## Production Deployment Checklist

Before deploying to production, ensure you have:

- [ ] **Generated and configured proper Ed25519 updater keys**
- [ ] **Updated all application metadata** (name, version, identifier, publisher)
- [ ] **Reviewed and minimized plugin permissions**
- [ ] **Set up proper error tracking** and logging
- [ ] **Tested the auto-updater flow** with signed releases
- [ ] **Verified CSP configuration** (if applicable)
- [ ] **Configured proper logging levels** (Info, not Debug)
- [ ] **Set up secure key storage** for CI/CD
- [ ] **Tested application on all target platforms**
- [ ] **Verified code signing certificates** for distribution

## Security Best Practices

### Input Validation

This template includes robust input validation for all Tauri commands:

- Filename validation prevents directory traversal attacks
- String length limits prevent buffer overflow attempts
- Theme validation ensures only allowed values
- Data size limits prevent resource exhaustion

### Error Handling

- Sensitive information is not exposed in error messages
- All file operations use atomic writes (write to temp, then rename)
- Failed operations are logged for security monitoring

### Logging

- Configure appropriate log levels for production (Info, not Debug)
- Ensure logs don't contain sensitive information
- Set up log rotation and retention policies

## Security Monitoring

Consider implementing:

1. **Error Tracking**: Services like Sentry or Rollbar
2. **Usage Analytics**: To detect unusual patterns
3. **Update Monitoring**: Track update success rates
4. **Crash Reporting**: To identify potential security issues

## Resources

- [Tauri Security Guide](https://tauri.app/distribute/updater/#signing-updates)
- [Ed25519 Key Generation](https://tauri.app/distribute/updater/#signing-updates)
- [Tauri Plugin Permissions](https://tauri.app/references/v2/permissions/)
- [Content Security Policy](https://developer.mozilla.org/en-US/docs/Web/HTTP/CSP)

## Support

If you encounter security issues or need help with configuration:

1. Review the [Tauri documentation](https://tauri.app/)
2. Check the [Tauri Discord community](https://discord.com/invite/tauri)
3. File security issues privately via email (see SECURITY.md)

---

**Remember**: Security is not a one-time setup. Regularly review and update your security configurations as your application evolves.
