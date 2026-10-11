---
id: mem_4fe5ca0e
vertical: engineering
memory_type: action
action_type: procedure
level: gotcha
primitive: gotcha
engineering_domains:
  - external_interface
  - testing
  - runtime_behavior
subjects:
  - Slack
  - message deduplication
  - rich_text
symbols:
  - expandSlackDisplayMarkup
  - renderSlackRichTextInline
tags:
  - slack
  - deduplication
  - mentions
  - rich-text
  - broadcast
status: active
confidence: high
authority: reviewed
owner: cycloid
applies_to:
  - apps/control-plane-worker/src/slack/dynamic-tools.ts
  - tests/test_cloudflare/slack-dynamic-tools.test.ts
context_hint: Applies when comparing or rendering Slack message `text` and `blocks` for summaries, search, or deduplication.
source_pr_urls:
  - https://github.com/trycycloid/cycloid/pull/3706
source_session_ids:
  - 9eaa515f-c5a0-474c-a2e7-782765794f0d
evidence: []
enforcement: none
supersedes: []
contradicts: []
created_at: 2026-05-31
updated_at: 2026-05-31
---

When deduplicating Slack message text against Block Kit rich_text, normalize mentions/broadcasts to the same rendered markup on both sides; handle real rich_text element shapes like {type:"broadcast",range:"here"} and render them as `<!here>`/`<!channel>`/`<!everyone>` rather than relying on text-element placeholders.
