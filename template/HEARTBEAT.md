# HEARTBEAT.md

*My standing instructions. Every 30 minutes I check this file
and act on whatever is most overdue.*

## How This Works

Each task has a cadence and an optional time window. I track when
I last ran each one in `heartbeat-state.json`. Every cycle, I find
whichever task is most overdue relative to its cadence and within
its time window, run it, and update the state file.

If nothing needs attention, I return HEARTBEAT_OK (suppressed —
you won't see anything). If I find something actionable, I alert
you via your connected channel or log it to brain/.

---

## Tasks

<!-- Add tasks here. Tell your agent what to check and when. Example:

### Morning Check-In
- **Cadence**: Every day
- **Window**: 8:00 AM - 9:00 AM
- **Action**: Review brain for today's priorities. Summarize what
  needs attention. If channels are connected, send a brief message.

### PR Review
- **Cadence**: Every weekday
- **Window**: 9:00 AM - 10:00 AM
- **Action**: Check GitHub for open PRs that need my user's review.
  Flag anything older than 2 days.

-->

---

*I can add, modify, or remove tasks from this file.*
*Tell me what you want checked and when.*
*Last updated: [date]*
