# Tech stack

Approved technologies per layer and explicit "do not introduce" guards.

| Layer                      | Technology                           | Notes                                                                                  |
| -------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| API / control plane        | Cloudflare Workers + Durable Objects | No Express, no Node on the server side                                                 |
| Database                   | Cloudflare D1 (SQLite)               | Raw SQL prepared statements, no ORM                                                    |
| UI                         | React 18 + Vite                      | No Next.js, no SSR                                                                     |
| Styling                    | Tailwind CSS                         | No CSS-in-JS, no styled-components                                                     |
| Sandbox runtime            | E2B template                         | VM-level isolation, active repo sessions                                               |
| Historical sandbox runtime | Previous pre-E2B provider            | Historical session metadata only                                                       |
| Sandbox bridge             | Node (TypeScript)                    | Runs inside the E2B sandbox                                                            |
| Agent SDK                  | Codex + Claude Agent SDK             | Per-session backend (`codex` default, `claude_code`); not LangChain, not Vercel AI SDK |
| Testing                    | Vitest                               | No Jest                                                                                |
| IaC                        | Terraform (Terraform Cloud)          | AWS + Cloudflare providers                                                             |
| CI/CD                      | GitHub Actions                       | Deploys on push to main                                                                |

Do not introduce libraries outside this stack without explicit approval. In particular: no ORMs (Drizzle, Prisma), no alternative runtimes (Express, Fastify), no state management libraries (Redux, Zustand), and no alternative unit-test frameworks (Jest). Playwright is used only for the existing E2E smoke setup.
