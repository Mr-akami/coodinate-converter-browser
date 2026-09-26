# 3. Refuse a ballpark transformation by default

Date: 2026-09-11

## Status

Accepted

## Context

When PROJ cannot reach an accurate transformation between two coordinate
reference systems — usually because a datum-shift grid is absent — it offers a
ballpark: a transformation that ignores the datum difference. The result can be
hundreds of metres out. Nothing in the returned coordinate says so.

`cs2cs` takes the ballpark, which is reasonable for a command line tool whose
user can see the warning it prints. A library returns three numbers.

The prototype also took the ballpark, while its own documentation claimed the
opposite. During this refactor we found a case where that mattered: at Naha,
EPSG:6667 to EPSG:6695 was silently returning the input height unchanged,
because the accurate operation's declared extent stops short of Okinawa and the
ballpark won the per-point selection.

## Decision

`transform` throws `MissingGridError` rather than returning a ballpark result.
`allowBallpark: true` opts into cs2cs behaviour. `describe` reports which
operation would be used, its accuracy, and whether it is a ballpark, so a
caller can decide per CRS pair rather than globally.

## Consequences

A caller who ignores errors gets an exception instead of a plausible wrong
number, which is the outcome we want when the alternative is silent error of
unknown size.

Callers who genuinely tolerate approximation have to say so. That is a real
cost, paid once per call site, and it makes the tolerance visible in the code.

The browser suite passes `allowBallpark: true` throughout, because its
reference values come from `cs2cs`. Comparing a strict run against them would
be comparing two policies and calling the difference a failure.

Errors distinguish a grid the Data Origin could supply from one it could not,
because the fixes differ: retry the fetch, or add the file to the origin.
