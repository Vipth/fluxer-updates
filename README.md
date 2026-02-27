Fluxer Status → Discord

This project sends Fluxer status updates to a Discord channel using GitHub Actions.

It checks:

https://fluxerstatus.com/summary.json

Every 5 minutes and posts to Discord only when something changes.

No server required. No bot hosting. No maintenance.

What it does

You’ll receive a Discord message when:

An incident starts

An incident status changes

Maintenance begins or updates

All systems return to operational

It does not repeat messages if nothing changes.

Setup (takes ~2 minutes)
1. Create your own copy

Click Use this template (top right of the repository) and create your own repo.

2. Create a Discord webhook

In Discord:

Server Settings

Integrations

Webhooks

New Webhook

Choose a channel

Copy the webhook URL

3. Add the webhook to GitHub

In your new repository:

Settings

Secrets and variables

Actions

New repository secret

Add:

Name:

DISCORD_WEBHOOK_URL

Value:

(paste your Discord webhook URL)

Save.

4. Enable Actions

Go to the Actions tab and enable workflows if prompted.

5. (Optional) Test it

Open the Actions tab

Select Fluxer → Discord

Click Run workflow

You should see a message appear in your Discord channel.

How it works

Every 5 minutes GitHub:

Starts a temporary runner

Fetches Fluxer’s status JSON

Compares it to the previous state

Sends a Discord message only if something changed

Saves the new state

Each run starts fresh, so there’s nothing to restart or maintain.

Customization

To change the check frequency:

Edit this line in .github/workflows/fluxer.yml:

cron: "*/5 * * * *"

To use a different Instatus-powered page:

Change SUMMARY_URL in check_fluxer.js.

Security

Your Discord webhook URL is stored in GitHub Secrets.
It is never committed to the repository.

Do not paste your webhook directly into the code.

License

MIT
