# Dockside privacy policy

Last updated: 17 November 2026.

Dockside is a Forge app for Jira, built by one independent developer for Codegeist 2026. It is free.

## What Dockside reads
- The work items in the Jira projects where it is used: summary, description, attachments' names, labels, status and comments it writes itself.
- Whether a user can browse a project or work item, to decide what that user may see.

## What Dockside stores
Everything is kept in the app's Forge storage (`storage:app`), which Atlassian hosts, separately for each installation:
- the result of each check (prices, quantities, VAT, findings, amounts in dispute);
- the price history built from approved notes, and the project's settings;
- an activity log of checks, decisions, setting changes and agent extractions. Each entry records the Atlassian account ID of the person who acted and the time. Account IDs are the only personal data Dockside stores.

Dockside also writes to Jira itself: a comment with the dispute letter when you press Dispute, and an entity property on each checked work item so you can search with JQL.

## What Dockside does not do
- It does not send data outside Atlassian. There is no external server, no egress and no third-party key in the app.
- It does not sell, share or analyse your data for any other purpose.
- The Rovo agent and the MCP tools run on Atlassian's platform and return results only to users who can see the work item or project.

## Deleting data
Uninstalling Dockside removes the app from the site; Atlassian then handles the app's Forge storage under its own retention rules. Comments and entity properties written to Jira stay in Jira, where a Jira admin can delete them like any other content. To ask for anything about your data, open an issue at https://github.com/antonmareo10/dockside/issues.
