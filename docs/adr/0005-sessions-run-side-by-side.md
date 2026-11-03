# ADR 0005: Sessions run side by side

Status: Accepted

Date: 2026-11-03, the date of commit `39d7ec8`, which introduced it.

## Context

Without sessions, the recorded order rule held across the whole recording, so a recording made by many independent clients replayed in the order the recording happened to have between those clients.

## Decision

`--session-key` names where a recorded request carries its session: a header, a cookie, or a JSONPath into the request body. Sends start in recording order within a session, the recorded order rule holds within a session, and sessions overlap up to `--concurrency`. Barrier tags and controls still wait for every earlier exchange of every session. A request that uses a substituted value waits for its producer in whichever session that ran. The exchanges whose request has no value at the key form one session of their own. Without the flag the whole recording is one session. The engine runs one worker per session with work in the window.

## Consequences

- A recording from many clients replays at the rate of many clients without inventing an order between two requests of one client.
- Ordering that the recording cannot speak for is kept: barriers, controls, and substitution dependencies cross sessions.
- A key that finds no value, or one value for every exchange, gives one session and the replay is as sequential as before.
- A session whose next exchange waits does not hold up the others.
