# Benchmark policy

`macos/backend/benchmark_policy.py` and `windows/benchmark-policy.cjs` own sample acceptance, completion, candidate selection and switch checks. Both policies consume recorded data. The backend callers own the probes, clock, cancellation signals and controller I/O.

| Parameter | macOS | Windows |
| --- | --- | --- |
| Allowed mode for chain benchmarks and automatic switching | `global` | `global` |
| Scheduled interval, default and range | 60 min, 1–1440 min | 60 min, 1–1440 min |
| Worker concurrency, default and range | 5, 1–10 | 5, 1–10 |
| Entrance probe | One HTTPS 204, 3 s connect and request timeout. Isolated probe deadline 4 s, polled every 50 ms | One HTTPS 204 in a chain run, 8 s timeout. Standalone entrance run uses one 8 s trace request |
| Chain probe | 8 s connect, 12 s request, 14 s process deadline, polled every 100 ms | 8 s per trace request |
| Chain samples | 2 successes out of up to 3, median rounded half to even | 2 successes out of up to 3, median rounded half up |
| Pause after a probe | 250 ms | 100 ms |
| Run checks | Chain checks before accepting results or starting more workers, with a 300 ms worker wait. Standalone entrance worker wait is 200 ms | After each completed node probe and on a 2.5 s guard interval |
| Isolated listener startup | Up to 40 attempts, 100 ms socket timeout and retry pause | Up to 40 attempts, 100 ms socket timeout and retry pause |
| Physical interface / listener ownership subprocess | 5 s / 3 s | PowerShell adapter timeout of 12 s |
| Child termination wait | 2 s after terminate, 2 s after kill if needed | Up to 1.8 s before forced kill |
| Required improvement over a verified current entry | At least 20 ms and 10% | At least 20 ms and 10% |

The first failed chain probe ends sampling when there is no successful sample yet. Candidate ranking uses chain delay by default and requires a verified chain even when ranking by entrance delay. The current entry must have a row from the run. If its chain failed, a verified candidate can replace it without a valid baseline. The selection is the node filter. A failed chain result is distinct from an entry missing from the selection.

On macOS, `chain` returns its snapshot and recommendation together. Swift renders the snapshot, updates progress and checks current UI consent, revision and entry before displaying the switch message and invoking `auto-switch`. That command rechecks the live state, network, route fingerprint, cancellation file and target owner under the existing lock. It then switches, verifies, and saves the selected entry. Starting the second command inside the first would move the switch before display and the last UI checks. Calling it for every run would change the busy and feedback sequence when Swift skips the switch.

On Windows, the benchmark waits for every worker and the in-flight guard, writes the history, then checks whether the scheduled run can switch. It reads the network, reads state and reloads the routing inputs in that order before the existing final authorization check and write. The post-write state check and release of `busy` stay in the same places. Windows uses the controller write for automatic switching. macOS also saves the selection to the Verge profile index.
