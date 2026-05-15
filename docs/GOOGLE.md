# Google Workspace

Butterclaw includes direct Google Workspace tools for Gmail and Google Calendar.
They use Google's REST APIs through Node's built-in `fetch`, so there are no
extra runtime dependencies.

## Setup

Put a Google OAuth access token in an environment variable:

```cmd
set GOOGLE_ACCESS_TOKEN=your-google-oauth-access-token
```

Then run Butterclaw normally:

```cmd
butterclaw "search gmail for unread messages"
butterclaw "list my calendar events for tomorrow"
```

If you use a different token variable or calendar:

```cmd
butterclaw --google-token-env MY_GOOGLE_TOKEN --google-calendar-id primary "list calendar events"
```

## OAuth Scopes

Use the least-powerful scopes that match what you want Butterclaw to do:

- Gmail search/read: `https://www.googleapis.com/auth/gmail.readonly`
- Gmail draft creation: `https://www.googleapis.com/auth/gmail.compose`
- Calendar event read/write: `https://www.googleapis.com/auth/calendar.events`

Butterclaw creates Gmail drafts but does not send Gmail messages directly.

## Tools

- `gmail_search`: search messages and return concise metadata.
- `gmail_read`: read a message by Gmail message ID.
- `gmail_create_draft`: create a draft email without sending it.
- `calendar_list_events`: list events from a calendar.
- `calendar_create_event`: create an event on a calendar.

Calendar IDs default to `primary`. Dates and datetimes should be ISO strings,
for example `2026-05-16` or `2026-05-16T10:00:00+05:30`.

## Safety

Google tokens are read from environment variables only. Do not paste tokens
into prompts, skills, memory, or repo files. Keep the token scope narrow and
remove it from the shell when you are done.
