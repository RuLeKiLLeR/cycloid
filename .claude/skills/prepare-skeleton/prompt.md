# Layer-2 prompt: make the skeleton build (without restoring logic)

Paste this into Claude Code (or your AI coding tool) **inside the generated `cycloid-skeleton/`
directory**. Its only job is to make the stubbed skeleton compile/typecheck. It must **not** restore
real business logic.

---

You are working inside an intentionally gutted code skeleton. Every source file has had its function
and method bodies removed by an automated tool, leaving imports and signatures. Comments, docstrings,
and literal values were stripped on purpose. Build/dependency/CI config files are real; source bodies
are deliberately fake.

Your task: make this project **build and typecheck** with the minimum possible change. Do not restore
or invent real logic.

Rules:

- Fill bodies with the smallest stub that satisfies the type/compiler only: `throw new Error("stub")`,
  `return null as any` / a zero value, `pass`, `todo!()`, etc. — whatever the language needs.
- Do not implement real behavior, algorithms, validation, queries, or constants. Placeholder values are
  expected and correct.
- Do not add new dependencies. Do not edit lockfiles or CI config.
- If a file is too damaged to stub cheaply, leave it and note it; do not reconstruct it.
- Stop once `install` + `build`/`typecheck` succeed. Passing tests is not a goal — tests will fail
  against stubs, and that is fine.

Report: the build/typecheck command you ran, its final status, and any files you could not make compile.
