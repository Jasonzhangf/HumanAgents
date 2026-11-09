# v33 Entry Task-List Drawer: Execution Contract

Goal: implement requirements v33 `humanagent-entry-task-list-in-drawer` for the HumanAgent entry surface. This task is the current implementation task for the v33 requirement; it does not change the requirement.

Scope:
- Add a task-list drawer to the HumanAgent entry UI.
- The drawer opens and closes from the entry page.
- It renders the current task list from the existing task source: task id, status, priority, owner.
- It keeps the existing entry navigation usable.
- It does not touch the production app cold-start or startup path.

Hard constraints:
- Use the existing project UI patterns and existing task source. Do not introduce a second copy of task data.
- Follow the project DAG gate and coding-principles workflow before and during implementation (figure check, red test, minimal change, real-entry black-box check).
- No production test code, test UI, or diagnostic popups in the startup path.
- Work in a dedicated Git worktree unless the owner confirms an existing isolated one.

Delivery condition:
- Entry page renders a drawer containing the task list; drawer toggles open and close; task data shown matches the existing task source; no production cold-start or startup code is added.

Test condition:
- Real frontend acceptance through the user entry path with reproducible evidence: open the drawer, see the task list, close it, and confirm the existing entry flow still works. Unit tests or build-only evidence are not sufficient.

Return evidence:
- Candidate branch/commit or file diff, development evidence, and real-entry black-box acceptance evidence with reproducibility steps.
- Task id: `humanagent-entry-task-list-drawer-20261108`.
- Parent task: `humanagent-mvp-delivery-20261106`.
- Report channel: return the result and evidence path to the dispatcher (master Jenny) through the task contract; do not merge, push, or close independently.

Authorized actions:
- Read and modify HumanAgent project source under the assigned worktree.
- Create the dedicated worktree and branch with the task slug and date.
- Run project tests and build checks.
- Record note evidence in the owned task note.

Stop conditions:
- Stop when delivery and test conditions are met and evidence is returned.
- Stop on scope conflicts, permission denial, or a real dependency gap; preserve the original error and report it.
