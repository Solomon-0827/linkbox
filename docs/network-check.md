# Network check verdicts

`macos/backend/network-verdict.js` and `windows/network-verdict.js` turn collected evidence into ordered cards with status, badge and detail, plus the report summary. The macOS module reads the report snapshot, which may still be waiting for either set of probes. The Windows module reads the completed native and browser results, plus the expected IP captured at launch and the formatted completion time. The views keep the derived native assessments in the downloaded JSON.

| Evidence | macOS | Windows |
| --- | --- | --- |
| System exits | HTTPS through TUN and the explicit proxy, plus two native IPv4 STUN probes | HTTPS through TUN and the explicit proxy |
| Claude Code connections | Correlates loopback sockets to port 7897 with Clash source ports. Ambiguous matches have no chain evidence. | Correlates established TCP connections by local port and source address when Clash supplies one. Ambiguous matches count as unmatched. |
| Network state | Reports a Clash mode, TUN and route snapshot | Compares network interfaces and Clash selection before and after the native checks |
| Local IPv6 | Global addresses from `ifconfig` and two TCP probes | Interface addresses after excluding internal, link-local, unique-local and `::`-prefixed addresses, plus two TCP probes |
| Browser WebRTC | Samples ICE for up to 15 seconds and lists nonmatching public candidates when there is a mismatch | Samples ICE for up to 10 seconds and lists all retained public candidates. Its filter also drops `::`-prefixed addresses, including compressed IPv4-mapped IPv6 candidates. |

Both verdicts use the existing parsed IP comparison, including equivalent IPv6 spellings. A returned browser IPv6 address is a warning that asks the user to verify the route. The local IPv6 card also warns when a probe connects, an interface has a public address, or the evidence is incomplete. An unexpected public IPv6 ICE candidate can trigger a WebRTC mismatch.

Run `node --test windows/test/network-verdict.test.cjs` to check both modules against `fixtures/network-verdict/`. Fixtures share evidence and expectations where the output matches and record platform-specific text and evidence where it differs. The fully verified fixture retains the browser IPv6 advisory.
