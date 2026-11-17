---
name: dockside
description: Check supplier delivery notes (albaranes) kept in Jira with the Dockside MCP tools - prices against the supplier's history, quantities, Spanish VAT, totals and duplicates - and answer questions about what is in dispute and which suppliers raised prices. Use when someone asks about a delivery note, a supplier's prices, or money in dispute in a Jira project that has Dockside installed.
---

# Dockside: delivery note checks from any MCP client

Dockside is a Forge app for Jira. Its MCP server (Atlassian's MCP gateway, `https://mcp.atlassian.com/forge/<appId>`, once a site admin enables it) exposes five read-only tools. They never save anything. Every figure comes from Dockside's deterministic engine, not from you: quote its numbers, don't recompute or round them.

## Tools

| Tool | Use it for | Inputs |
|---|---|---|
| `list-open-discrepancies` | "What's still in dispute?", "What's wrong with Pescados Rompeolas' notes?" | `projectKey` (optional), `supplier` (optional) |
| `list-price-changes` | "Which suppliers raised prices this month?" | `projectKey` (optional), `days` (optional, default 90) |
| `get-price-history` | "What did we pay for hake before?" | `supplier` (required), `item` (optional), `projectKey` (optional) |
| `check-delivery-note` | Check one note: a work item, or text that is not in Jira yet | `issueKey`, or `noteText` + `projectKey`, optionally `extractedJson` |
| `parse-delivery-note` | See how Dockside reads a note's text into lines, without checking it | `noteText` (required) |

## How to answer well

1. Start from the question, not from a tool tour. "What's in dispute" → `list-open-discrepancies`; "who raised prices" → `list-price-changes` with the period the person said (30 days for "this month").
2. Each finding comes with the work item key, the line number and the exact quoted line. Pass those on, so the person can open the note and see the line.
3. Money: say whether an amount is before VAT or VAT included, exactly as the tool says. Don't add amounts across findings yourself; the tools give totals.
4. Hand-typed notes: if `check-delivery-note` reports that a line may not have been read, you may read the note yourself and send your reading back as `extractedJson` (supplier, number, date, lines with `lineNo` and the exact `source` text, totals). Dockside rejects any line whose quote is not in the note or whose numbers are not in the quote. If it rejects your extraction, say so; never present it as checked.
5. You can't approve or dispute through MCP. Those decisions are made by a person in Jira (the Dockside panel on the work item) or by the Receiving Clerk Rovo agent with the person's confirmation.
6. Access: tools run as the user and Dockside checks Browse Projects on the project or work item. If a tool refuses, tell the person they don't have access to that project; don't retry with another key.

## Example

> Which suppliers raised prices in KR over the last 30 days?

Call `list-price-changes` with `projectKey: "KR"`, `days: 30`. Answer with each supplier, the item, the old and new price, the percentage and the work items, in the tool's order.
