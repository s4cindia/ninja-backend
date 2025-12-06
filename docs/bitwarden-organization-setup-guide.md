# Bitwarden Organization Setup Guide

## For S4Carlisle India Development Team

**Version:** 1.0  
**Last Updated:** December 2025  
**Audience:** Team Lead, DevOps, Developers

---

## Overview

Bitwarden is a secure, open-source password and secrets manager. This guide covers setting up a Bitwarden Organization for the S4Carlisle India development team, including how to transfer existing secrets from personal accounts to the shared organization vault.

---

## Why Bitwarden for Team Secrets Management?

### Current Challenge

Developers currently store sensitive credentials (AWS keys, API tokens, database passwords) in:
- Personal password managers
- Local files
- Scattered documentation

This creates security risks and makes onboarding new team members difficult.

### Benefits of Bitwarden Organizations

| Benefit | Description |
|---------|-------------|
| **Centralized Secrets** | All team credentials in one secure location |
| **Access Control** | Grant access by role using Collections |
| **Audit Trail** | Track who accessed what and when |
| **Secure Sharing** | No more sharing secrets via email or chat |
| **Onboarding** | New developers get instant access to required secrets |
| **Offboarding** | Revoke access immediately when team members leave |
| **Cross-Platform** | Browser extensions, mobile apps, CLI tools |

---

## Subscription Options

### Bitwarden Plans Comparison

| Plan | Cost | Users | Best For |
|------|------|-------|----------|
| **Teams Starter** | $20/month (flat) | Up to 10 users | ✅ S4Carlisle India Team |
| **Teams** | $4/user/month | Unlimited | Larger teams (11+) |
| **Enterprise** | $6/user/month | Unlimited | Advanced compliance needs |

### Recommendation for S4Carlisle India

**Teams Starter Plan - $20/month ($240/year)**

Rationale:
- Current team size: 9 developers + 1 PM = 10 users (exact fit)
- Includes all essential features (Collections, secure sharing, 2FA)
- Cost-effective at ~₹1,700/month
- Can upgrade to Teams plan if team grows beyond 10

---

## Initial Setup (Admin)

### Step 1: Create Organization

1. Go to [bitwarden.com](https://bitwarden.com) and sign in (or create account)
2. Click **New Organization**
3. Enter details:
   - **Organization Name:** S4Carlisle India
   - **Billing Email:** [billing contact email]
4. Select **Teams Starter** plan
5. Complete payment
6. Organization is created

### Step 2: Create Collections

Collections are like shared folders. Create the following structure:

| Collection Name | Purpose | Access Level |
|-----------------|---------|--------------|
| **Ninja-Development** | Development environment secrets | All Developers |
| **Ninja-Staging** | Staging environment secrets | All Developers |
| **Ninja-Production** | Production secrets | Tech Lead, DevOps only |
| **AWS-Credentials** | AWS IAM keys, account IDs | DevOps, Tech Lead |
| **Third-Party-Services** | Gemini API, SendGrid, etc. | All Developers |
| **Database-Credentials** | Neon, RDS connection strings | All Developers |
| **GitHub-Tokens** | GitHub PATs, deploy keys | DevOps, Tech Lead |

**To create a Collection:**
1. Go to Organization → Collections
2. Click **New Collection**
3. Enter name and description
4. Click **Save**

### Step 3: Invite Team Members

1. Go to Organization → Members
2. Click **Invite Member**
3. Enter email address
4. Select **User** type (or **Admin** for Tech Leads)
5. Assign to appropriate Collections
6. Click **Save**

Repeat for all team members.

### Step 4: Configure Access Permissions

| Role | Collections Access | Permissions |
|------|-------------------|-------------|
| **PM** | Ninja-Development, Third-Party-Services | View Only |
| **Developers** | Ninja-Development, Ninja-Staging, Third-Party-Services, Database-Credentials | View Only |
| **Tech Lead** | All Collections | Can Manage |
| **DevOps** | All Collections | Can Manage |

---

## Transferring Personal Secrets to Organization

If you have secrets in your personal Bitwarden vault that need to be shared with the team:

### Method 1: Assign Existing Item to Collection

1. Open your **Personal Vault**
2. Find the item (e.g., "AWS Access Key - Staging")
3. Click the item to open it
4. Click the **three-dot menu (⋮)**
5. Select **"Assign to collections"**
6. Check **"S4Carlisle India"** organization
7. Select the appropriate collection (e.g., "AWS-Credentials")
8. Click **Assign**

> ⚠️ **Note:** The item becomes organization-owned. You retain access through the collection, but it's no longer in your personal vault.

### Method 2: Create New Item Directly in Organization

1. Go to Organization Vault
2. Click **Add Item**
3. Fill in details:
   - **Name:** Descriptive name (e.g., "Gemini API Key - Production")
   - **Username:** (if applicable)
   - **Password/Value:** The secret value
   - **URI:** Related URL (if applicable)
   - **Notes:** Context, expiration date, rotation schedule
4. Select **Collection(s)** to add to
5. Click **Save**

---

## Recommended Secret Naming Convention

Use consistent naming for easy identification:

```
[Service] - [Environment] - [Purpose]
```

**Examples:**

| Secret Name | Collection |
|-------------|------------|
| `AWS Access Key - Staging` | AWS-Credentials |
| `AWS Secret Key - Staging` | AWS-Credentials |
| `AWS Access Key - Production` | AWS-Credentials |
| `Neon Database URL - Staging` | Database-Credentials |
| `RDS Database URL - Production` | Database-Credentials |
| `Gemini API Key` | Third-Party-Services |
| `JWT Secret - Staging` | Ninja-Staging |
| `JWT Secret - Production` | Ninja-Production |
| `GitHub Deploy Key - ninja-backend` | GitHub-Tokens |

---

## Daily Usage for Developers

### Installing Bitwarden

| Platform | Installation |
|----------|--------------|
| **Browser** | Install extension from Chrome/Firefox/Edge store |
| **Desktop** | Download from bitwarden.com/download |
| **Mobile** | iOS App Store / Google Play Store |
| **CLI** | `npm install -g @bitwarden/cli` |

### Accessing Secrets

1. Click Bitwarden extension icon
2. Log in with your credentials
3. Switch to **S4Carlisle India** organization vault
4. Browse or search for the secret you need
5. Click **Copy** to copy the value

### Using Secrets in Replit

1. Open Bitwarden and find the secret
2. Copy the value
3. In Replit, go to **Secrets** (lock icon)
4. Add new secret with the copied value

---

## Security Best Practices

### Do's ✅

- Enable **Two-Factor Authentication (2FA)** on your Bitwarden account
- Use the **browser extension** for auto-fill (avoid copy-paste when possible)
- **Lock your vault** when stepping away (`Ctrl+Shift+L`)
- Report any suspected security incidents immediately
- Rotate secrets periodically (quarterly for API keys)

### Don'ts ❌

- Never share your Bitwarden master password
- Never export vault contents to unencrypted files
- Never share secrets via email, Slack, or Teams chat
- Never store Bitwarden master password in Bitwarden itself
- Never use the same password for Bitwarden as other services

---

## Onboarding New Team Members

### Checklist for Admin

1. [ ] Invite new member to Bitwarden Organization
2. [ ] Assign to appropriate Collections based on role
3. [ ] Send welcome email with:
   - Link to accept invitation
   - This setup guide
   - Collection access they have
4. [ ] Verify they can access required secrets
5. [ ] Add their email to appropriate GitHub team

### Checklist for New Member

1. [ ] Accept Bitwarden Organization invitation
2. [ ] Install Bitwarden browser extension
3. [ ] Enable Two-Factor Authentication
4. [ ] Verify access to assigned Collections
5. [ ] Test copying a secret to Replit

---

## Offboarding Team Members

### Immediate Actions (Admin)

1. Go to Organization → Members
2. Find the departing member
3. Click **Remove** → Confirm
4. The member loses access to all organization secrets immediately

### Post-Departure Actions

1. [ ] Rotate any secrets the member had direct access to
2. [ ] Review audit logs for recent access
3. [ ] Update any shared credentials they knew
4. [ ] Remove from GitHub organization
5. [ ] Remove from Replit team

---

## Troubleshooting

### Problem: Can't see organization vault

**Solution:**
1. Click the Bitwarden extension
2. Click your account icon (top right)
3. Select **S4Carlisle India** from the vault dropdown

### Problem: Can't access a specific collection

**Solution:**
1. Contact your Admin/Tech Lead
2. Request access to the specific collection
3. Admin will update your permissions

### Problem: Forgot master password

**Solution:**
1. Bitwarden cannot recover your master password
2. Contact Admin to remove and re-invite you
3. You'll need to set up a new master password
4. Enable a recovery method (emergency contact)

---

## Audit and Compliance

### Viewing Audit Logs (Admin)

1. Go to Organization → Reporting → Event Logs
2. Filter by date, member, or event type
3. Export logs for compliance reporting

### Events Tracked

- Member logins
- Secret access (view/copy)
- Secret modifications
- Collection changes
- Member additions/removals

---

## Cost Summary

| Item | Cost (USD) | Cost (INR approx.) |
|------|------------|-------------------|
| Teams Starter (monthly) | $20 | ₹1,700 |
| Teams Starter (annual) | $240 | ₹20,400 |

**ROI Justification:**
- Eliminates security risk of scattered secrets
- Reduces onboarding time by ~2 hours per developer
- Provides audit trail for compliance
- Prevents accidental secret exposure

---

## Support and Resources

| Resource | Link |
|----------|------|
| Bitwarden Help Center | https://bitwarden.com/help/ |
| Bitwarden Community | https://community.bitwarden.com/ |
| Internal Support | Contact Tech Lead or PM |

---

*Document maintained by S4Carlisle India Development Team*
