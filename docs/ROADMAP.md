# Weft — Next Steps & Ambitious Roadmap

v1 is done (see `PLAN.md`): CRDT core, sync protocol, crash-safe server, WASM bindings, and an offline-first
web app that passes 16/16 checks in headless Chromium. This roadmap covers what comes next, from quick wins to
moonshots. Each track has its own detailed file, with research, a phased plan, implementation sketches, and risks.

## Tracks

| # | Track | File | One-line pitch |
|---|---|---|---|
| 1 | Distributed systems | [roadmap/01-distributed.md](roadmap/01-distributed.md) | Multi-node cluster, failover, peer-to-peer WebRTC: the CRDT makes all of it safe |
| 2 | Security & privacy | [roadmap/02-security.md](roadmap/02-security.md) | End-to-end encryption with the key in the URL fragment; permissions; abuse protection |
| 3 | Editor & collaboration features | [roadmap/03-features.md](roadmap/03-features.md) | Comments, suggestions, attribution, slash commands, AI co-writer |
| 4 | Performance & scale | [roadmap/04-performance.md](roadmap/04-performance.md) | Beat Yjs/Automerge/Loro on benchmarks; history checkpoints; load testing |
| 5 | Platform & ecosystem | [roadmap/05-platform.md](roadmap/05-platform.md) | CLI, desktop (Tauri), mobile, Git/Obsidian sync, one-click deploy, observability |
| 6 | Quality, DevEx & launch | [roadmap/06-launch.md](roadmap/06-launch.md) | CI, fuzzing, README/demo, docs site, a launch plan |

## Immediate next steps (this week)

- [ ] README with screenshots/GIF, an architecture diagram, and the benchmark table
- [ ] Run `scripts/dev.sh` end to end; fix anything rough
- [ ] Check cross-tab BroadcastChannel sync while offline in a real browser
- [ ] Investigate the rare unsynced-count overcount (seen 1 of 5 runs)
- [ ] Real-phone pass and a `prefers-reduced-motion` check
- [ ] Commit the Playwright E2E scripts (`web/e2e/`) as an optional `npm run e2e`
- [ ] Handle SIGTERM for graceful shutdown (`weft-server` only handles Ctrl-C today, `crates/weft-server/src/lib.rs:286`), which is a prerequisite for Docker/Fly
- [ ] Dockerfile and a deploy to a public URL, so people can try it
- [ ] **Security Phase 0 before going public** (4–6 days, no protocol change, see track 2):
  - cut the frame cap from 16 MiB to 1 MiB
  - add rate limits, connection caps and per-doc size quotas
  - add a first-message deadline and an Origin check
  - bind presence messages to the connection's client id
  - limit the core's buffer for out-of-order ops
  - validate peer names and colours
  - add security headers

## Decisions needed

- [ ] **E2EE vs "the server is a replica"**: end-to-end encryption turns the server into a blind ciphertext relay, which means no
      server-side merge, export or AI on encrypted docs. Proposal: make E2EE per-doc and opt-in (tracks 2, 3 and 5 all depend on this).

## Suggested sequencing

1. **Ship it** (track 6 plus Docker from track 5): a public demo makes everything else matter.
2. **Headline feature** (track 2 E2EE or track 3 comments/AI): the thing people share.
3. **Distributed showcase** (track 1 multi-node): the resume-grade systems story.
4. **Scale & polish** (track 4): benchmarks blog post vs Yjs/Automerge/Loro.
