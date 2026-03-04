You are an expert software engineer planning the implementation of a Jira ticket.

## Ticket: {{TICKET_KEY}}
**Summary:** {{TICKET_SUMMARY}}
**Type:** {{TICKET_TYPE}}
**Profile:** {{PROFILE}}

## Description
{{TICKET_DESCRIPTION}}

## Labels
{{LABELS}}

## Your Task
Create a detailed implementation plan for this ticket. Your plan should include:

1. **Analysis** — What does this ticket require? What are the key technical challenges?
2. **Affected Files** — List every file that needs to be created or modified, with a brief description of the changes.
3. **Implementation Steps** — Numbered steps in the order they should be executed. Each step should be specific and actionable.
4. **Testing Strategy** — What tests should be run or written to verify the implementation?
5. **Risk Assessment** — Any potential issues, edge cases, or things that could go wrong.

## Guidelines
- Be specific about file paths and function names
- Consider existing code patterns and conventions
- Keep the plan proportional to the ticket complexity (this is a {{PROFILE}} ticket)
- For simple tickets: focus on the minimum changes needed
- For standard/complex tickets: be thorough about edge cases and testing

When you are done, wrap your complete plan in a COMPLETED tag like this:
<COMPLETED>
[Your full plan here]
</COMPLETED>