# Plan Necessity Eval

Offline eval for `assessPlanNecessity`.
It runs the production classifier path against `dataset.jsonl`, writes a JSON report under `runs/`, and prints the summary last.

## Run

Set a real platform OpenAI key, then run:

```bash
ARCANIST_OPENAI_API_KEY=... npm run eval:plan-necessity
```

Useful iteration flags:

```bash
npm run eval:plan-necessity -- --filter multi-feature
npm run eval:plan-necessity -- --repeat 3
npm run eval:plan-necessity -- --min-accuracy 0.9
```

`--repeat` measures flip rate.
`--filter` matches case id, prompt text, or source.
Generated reports are ignored by git in `evals/plan-necessity/runs/`.

## Dataset

Each `dataset.jsonl` line is one labeled prompt:

```json
{ "id": "multi-feature-01", "prompt": "...", "expected": true, "note": "asks for three things", "source": "synthetic" }
```

Required fields:

- `id`: unique stable case id.
- `prompt`: non-empty prompt text sent to the classifier.
- `expected`: `true` when an upfront plan is warranted, `false` when the agent should just answer or act.
- `note`: one-line label rationale.
- `source`: provenance bucket such as `synthetic`, `dogfood-paraphrase`, or `truncation-probe`.

Optional fields:

- `postTruncationPrompt`: extra instruction text for `truncation-probe` rows.
  The runner pads the visible `prompt` past the classifier cutoff, then appends this tail so it should not affect the expected label.

Customer prompt text must not be checked in.
Use synthetic or internal dogfood prompts, paraphrased by default.
Verbatim internal prompts require a scrub check for secrets, tokens, PII, and customer context.

## Labels

Label against the rubric in `PLAN_NECESSITY_SYSTEM_PROMPT`.
Use `expected: true` for broad features, sequencing-dependent work, ambiguous goals, multi-request prompts, and explicit plan or TODO requests.
Use `expected: false` for typo fixes, one-file edits, direct questions, and single command or reporting tasks.

For `source: "truncation-probe"`, label the visible `prompt` prefix.
Use `postTruncationPrompt` for contradictory or distracting instructions that should sit after the classifier truncation boundary.

Dataset edits should accompany any change to `PLAN_NECESSITY_SYSTEM_PROMPT` or `PLAN_NECESSITY_MODEL`.
The eval gate uses effective accuracy, where `null` is treated as production's default no-plan outcome.
