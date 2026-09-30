# Task list density acceptance

Product candidate: `104b04ea1a25636c16ca24923438a4fd7fdf624c`, based on origin/main `b7dd425c3b3c9df64128e4b757cb8c995a742d97`.

Actual candidate static UI at port 57603 reads unchanged GET API responses from canonical port 10086. This is a read-only list/layout acceptance; it does not prove independent orchestration, timing, stopping, or the three Dashboard execution scenarios.

Root candidate `pnpm test:ui`: exit 0, 37 tests passed, 0 failed/skipped. Previous build:contracts and typecheck on cbcf565 passed; subsequent changes affect mobile CSS and evidence only. Author mobile build:contracts/typecheck/test:ui raw results are committed under docs/evidence/list-mobile-close-20260930/gate-raw.log.

Browser checks on this candidate: desktop 1280 and intermediate 768 preserve aligned list columns and real titles/status/update/actions. Responsive iframe at 390 shows no desktop header card and horizontal filter labels. Long title wraps within the card. Routes remain task.html for blocked input and task-dashboard.html for completed execution. Selecting all displayed tasks shows 2 selected; clear restores 0. No destructive actions were executed.

Final screenshots: candidate-desktop-r2.jpg, candidate-medium-r2.jpg, candidate-mobile-r2.jpg. Earlier mobile screenshots and candidate-browser-facts.json document a rejected predecessor; they are not final PASS evidence. Narrow iframe is responsive layout evidence, not physical mobile device evidence.

Source and served asset hashes matched: tasks.js `211ea53b6069f0e30aa2365adcfbf3b131385b864973b27f2505c43749e67140`; tasks.css `eee1e2b6a425d28bf66075dfb10934312ad103f1a0f8eb27781e54c81ea9ed13`. Desktop read-only DOM measurement: viewport 1280x720, document overflow false; header and data rows all have `44px 730px 84px 108px 116px` tracks.

The initial independent OAuth/gpt-6.1-sol review rejected missing accessible browser evidence; this receipt and screenshots make that completed verification readable inside the candidate. Product files are unchanged from the tested SHA. Delivery/install and new independent review remain pending. Root closed all five owned Browser tabs and sent TERM to exact consumer PID23907/port57603 and predecessor PID26992/port53761. `ps -p` found neither PID; requests to both ports failed with curl exit7 (connection refused). Author and delivery worktrees remain owned recovery resources until integration concludes; final worktree disposal follows merge, and is not claimed complete here.
