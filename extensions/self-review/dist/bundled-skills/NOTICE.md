# Bundled review skills: third-party notices

Self-Review ships unmodified copies of the following upstream skill files. Each
is pinned to an upstream tagged release; `manifest.json` records the exact
release commit, the last commit that changed the file, and a SHA-256 of its text.
Self-Review checks the hash before supplying a skill to a review run.

| Skill | Upstream | Release (commit) | File commit | License |
| --- | --- | --- | --- | --- |
| `code-review-and-quality` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills/blob/0.6.15/skills/code-review-and-quality/SKILL.md) | 0.6.15 (8bfcc1f) | 28f435e | MIT, `licenses/agent-skills-LICENSE.txt` |
| `code-simplification` | [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills/blob/0.6.15/skills/code-simplification/SKILL.md) | 0.6.15 (8bfcc1f) | f1f6fbf | MIT, `licenses/agent-skills-LICENSE.txt`; see below |
| `ponytail-review` | [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail/blob/v5.3.3/skills/ponytail-review/SKILL.md) | v5.3.3 (7801d06) | 2a1fe84 | MIT, `licenses/ponytail-LICENSE.txt` |

`code-simplification` states that it is inspired by and adapted from Anthropic's
Claude Code Simplifier plugin
([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official),
Apache-2.0; referenced file at commit ceb9b72). The Apache License 2.0 text,
taken from that repository at commit e37d307, is included conservatively as
`licenses/claude-plugins-official-LICENSE.txt`.

Copyright remains with the respective authors. This notice records sources and
license texts; it is not a legal opinion. Updates are manual: replace a file with
a newer tagged release, then update `manifest.json` and this table.
