# Ownership

What we mean when we ask "can you own this?"

Owning something means owning the solution to a problem end to end: from "we have a problem" to "we don't have to think about it again." Not the task - the outcome. If you own it, nothing about it is implicitly someone else's job.

## Before you build

- **Solve the problem, not the solution you arrived with.** "Migrate X to Y" is a solution. The problem is "performance is bad" or "it fails for customer X." Name the real problem, list other solutions, pick one on tradeoffs.
- **Edge cases:** which matter, which we ignore, and why.
- **Failures:** network failures are a given. Retry? How often, how long?
- **Data flow:** how much data, does it migrate or need cleanup, what invariants hold, which assumptions about its shape are still unconfirmed?
- **Testing:** how will you _know_ it's correct? Are tests enough, or do you need to poke at it manually? Is the difference visible in a screenshot or video?

## Before you merge

- **Do the work with precision, care, urgency, and calm.** Don't half-ass it. Ask: am I proud of this? Would I show it to Carmack and say "here's what I built, under these constraints, with these tradeoffs"?
- **Test it manually.** Automated tests exist, but in ~99% of cases you can confirm it yourself: run it, have an agent walk test scenarios, diff the data before and after, take screenshots, make a demo. Are you _sure_ it solves the problem?

## After you merge

- **Ship it and confirm it works in production.** Deployed? Deploy fail? Feature flag on and working? Can you use it in prod?
- **Tell the people who need to know.** New feature to test, new convention, a tricky behavior change - say so. Don't underestimate peripheral vision: "person X changed how Z works yesterday" saves person Y three hours of debugging tomorrow.
- **Tell customers when it's theirs.** Who reported the bug? Who was blocked? Close the loop. If the world should know, announce it.
- **Follow up.** Do you need to check the logs on what you shipped - a week later, maybe?

## The point

This is how you build a product on a small team with no PMs and no QA department. It's always okay to ask for help, ask questions, redo things, and triple-check. What's not okay is to implicitly assume someone else will handle the things you didn't think about.
