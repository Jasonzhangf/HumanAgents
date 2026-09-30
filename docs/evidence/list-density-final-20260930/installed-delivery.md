# Installed list density acceptance

Reviewed candidate: `2fdaac03e4c5bc85b1420d9b14f002f93b759b92`; product bytes unchanged from tested `104b04ea1a25636c16ca24923438a4fd7fdf624c`. Independent task `orch-list-density-final-r2-20260930` used OAuth and explicit gpt-6.1-sol; controller PASS, exit0, valid JSON retained as review-r2.json.

Before installation, installed tasks.js/tasks.css were byte-identical to canonical main. Only these two reviewed build outputs were staged and atomically renamed in `/opt/homebrew/lib/node_modules/humanagent-cli/runtime/ui`. Source, dist/app/ui, installed files and HTTP responses all match:

- tasks.js: `211ea53b6069f0e30aa2365adcfbf3b131385b864973b27f2505c43749e67140`
- tasks.css: `eee1e2b6a425d28bf66075dfb10934312ad103f1a0f8eb27781e54c81ea9ed13`

Canonical server PID17515 remains `node /opt/homebrew/bin/humanagent --workspace /Volumes/extension/code/humanagent --port 10086`. Its installed server.js hash remains `5f942639a7e6e54c55c1b4a51802238a3373b3f671ed4b4cf9e8ac6497d37b12`. Server code is unchanged and static files are read each request with no-store, so restart is not applicable. Package version is unchanged; this is a local static asset delivery, not a package publication.

Fresh actual Browser tab loaded http://127.0.0.1:10086/tasks.html. At1280x720 document overflow=false, placeholderCount=0, every header/data row has `44px 730px 84px 108px 116px` tracks. Select all displays2 selected, clear restores0. Both existing tasks retain real titles, blocked/completed states, updated times and their proper links. No existing task was modified/stopped/deleted. Screenshot installed-list.jpg records the actual page. This owned tab was then closed.

Candidate390/768 responsive evidence remains valid because installed assets are identical. No backend orchestration, scheduler, stop or Dashboard three-class execution acceptance is claimed by this list-only result. Git integration and owned worktree disposal remain pending; record their receipts after completion.
