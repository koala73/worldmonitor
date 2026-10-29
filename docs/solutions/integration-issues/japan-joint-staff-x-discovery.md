# Joint Staff X coverage for Japan review candidates

## Evidence from 2026-10-24

The authenticated X API returned the official `jointstaffpa` timeline and full text with attached media. The [MOD account directory](https://www.mod.go.jp/j/press/net/index.html) identifies this account. Its API account ID is `864751444586397696`.

The [Japanese Joint Staff press index](https://www.mod.go.jp/js/press/index.html) had 20 unique individual aircraft and vessel releases from September 28 through October 23. Each had a corresponding original X post with images in the inspected sample. A duplicate index link was counted once. Monthly and quarterly summaries, exercises, personnel news, and other announcements were outside this comparison. This sample supports current review-candidate discovery. It does not prove permanent or historical completeness.

The API returned HTTP 200 for 50 timeline posts. A second inspection retrieved full text and 48 attached media records for 21 activity posts, including one monthly summary outside the comparison. The full text is necessary. The short October 19 aircraft post omits the TB-001 report. The full post includes BZK-005, Y-9, and TB-001 aircraft. The October 20 full post includes two Y-9 aircraft with different roles.

The October 19 aircraft text was compared with the [official PDF](https://www.mod.go.jp/js/pdf/2026/p20261019_06.pdf). Its attached map was also opened in the browser and visually checked for the three aircraft types and routes. The October 9 TB-001 text was compared with its [official PDF](https://www.mod.go.jp/js/pdf/2026/p20261009_02.pdf). These spot checks support use as review evidence. They are not a complete audit of every numerical claim or image.

| Release day | Report | Official X post | Images |
| --- | --- | --- | --- |
| 2026-10-23 | Russian IL-20 | [2113591378357936172](https://x.com/jointstaffpa/status/2113591378357936172) | 2 |
| 2026-10-22 | Russian IL-20 | [2113227617276956698](https://x.com/jointstaffpa/status/2113227617276956698) | 2 |
| 2026-10-21 | Chinese Y-9 | [2112851766182379670](https://x.com/jointstaffpa/status/2112851766182379670) | 2 |
| 2026-10-20 | Two Chinese Y-9 aircraft | [2112518654814486834](https://x.com/jointstaffpa/status/2112518654814486834) | 3 |
| 2026-10-20 | Jiangkai II 532 | [2112452519733661992](https://x.com/jointstaffpa/status/2112452519733661992) | 2 |
| 2026-10-19 | BZK-005, Y-9, TB-001 | [2112200180078645347](https://x.com/jointstaffpa/status/2112200180078645347) | 4 |
| 2026-10-19 | Dongdiao 798 | [2112115067080917251](https://x.com/jointstaffpa/status/2112115067080917251) | 2 |
| 2026-10-19 | Dongdiao 796 | [2112115059849920517](https://x.com/jointstaffpa/status/2112115059849920517) | 2 |
| 2026-10-19 | Destroyer 121 and support ship 901 | [2112115053659058601](https://x.com/jointstaffpa/status/2112115053659058601) | 2 |
| 2026-10-19 | Destroyer 122 and two other ships | [2112115047174684825](https://x.com/jointstaffpa/status/2112115047174684825) | 2 |
| 2026-10-19 | Russian IL-20 | [2112061208379699363](https://x.com/jointstaffpa/status/2112061208379699363) | 2 |
| 2026-10-15 | Chinese Y-9 | [2110675865172684924](https://x.com/jointstaffpa/status/2110675865172684924) | 2 |
| 2026-10-15 | Liaoning carrier operations | [2110662738573992119](https://x.com/jointstaffpa/status/2110662738573992119) | 2 |
| 2026-10-14 | Presumed UAV, Y-9, WZ-7 | [2110355583971053644](https://x.com/jointstaffpa/status/2110355583971053644) | 3 |
| 2026-10-14 | Liaoning group transit | [2110317371932205415](https://x.com/jointstaffpa/status/2110317371932205415) | 2 |
| 2026-10-13 | Chinese Y-9 | [2109981505351270838](https://x.com/jointstaffpa/status/2109981505351270838) | 2 |
| 2026-10-09 | Russian IL-20 | [2108543012695618026](https://x.com/jointstaffpa/status/2108543012695618026) | 2 |
| 2026-10-09 | Chinese TB-001 | [2108543011072462927](https://x.com/jointstaffpa/status/2108543011072462927) | 2 |
| 2026-10-09 | Russian frigate | [2108477879176876458](https://x.com/jointstaffpa/status/2108477879176876458) | 2 |
| 2026-09-28 | Russian frigate | [2104496826007146498](https://x.com/jointstaffpa/status/2104496826007146498) | 3 |

## Seeder behavior and limits

When `X_BEARER_TOKEN` is configured, Japan discovery reads the official account timeline through the X API. It requests `note_tweet` and attached media, as defined by the [X post timeline](https://docs.x.com/x-api/users/get-posts) and [data dictionary](https://docs.x.com/x-api/fundamentals/data-dictionary). It uses full note text when present and retains original Japanese text, publication time, post URL, and photo URLs. The images remain external references. The seeder does not download or interpret them.

The read covers the previous three days, once per 12-hour UTC slot, with at most 25 posts per request. The shared X budget holds 25 posts for each of the two daily slots so on-demand Company Monitoring cannot spend them first. On the day this hold deploys, the stored budget model is still the lower one, so that day reads from spare capacity. All original posts can become review candidates. Filtering by words could omit announcements whose details appear only in images. The existing limit retains the newest 15 candidates. This is a bounded review queue, not an archive. An outage longer than three days needs a separate coverage check.

The shared X budget must admit the request and settle its returned-post count. Budget denial, API errors, missing media, and an additional results page fail the read. A valid empty window succeeds without creating observations. Cached results preserve the acquisition time. Failed reads retain previous candidates and the previous success time.

The two existing manually reviewed observations remain the only admitted Japan observations. New X candidates require review before admission. Candidate text, image URLs, and poll diagnostics stay out of the public bootstrap response. Without the token, the existing MOD discovery path remains active.

On 2026-10-24, `seed-bundle-derived-signals` had the shared Redis variables but no `X_BEARER_TOKEN`. Activation requires the existing X credential on that service and deployment of this change. Neither was performed during this investigation. Local tests and captured API evidence do not establish scheduled production recovery.
